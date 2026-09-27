package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/config"
	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/delegate"
	"github.com/ding113/claude-code-hub/edge/internal/gate"
	"github.com/ding113/claude-code-hub/edge/internal/upstream"
)

// fakeControl scripts decide/next responses and records what the edge sent.
type fakeControl struct {
	mu      sync.Mutex
	decide  func(*contract.RequestDigest) (*contract.DecideResponse, error)
	next    func(*contract.NextRequest) (*contract.NextResponse, error)
	digests []*contract.RequestDigest
	nexts   []*contract.NextRequest
}

func (f *fakeControl) Decide(_ context.Context, digest *contract.RequestDigest) (*contract.DecideResponse, error) {
	f.mu.Lock()
	f.digests = append(f.digests, digest)
	f.mu.Unlock()
	return f.decide(digest)
}

func (f *fakeControl) Next(_ context.Context, request *contract.NextRequest) (*contract.NextResponse, error) {
	f.mu.Lock()
	f.nexts = append(f.nexts, request)
	f.mu.Unlock()
	if f.next == nil {
		return &contract.NextResponse{Action: "fail", Response: &contract.FailResponse{Status: 502, BodyText: "{}"}}, nil
	}
	return f.next(request)
}

func (f *fakeControl) nextRequests() []*contract.NextRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*contract.NextRequest(nil), f.nexts...)
}

type fakeReporter struct {
	mu         sync.Mutex
	completes  []*contract.CompleteRequest
	heartbeats int
	done       chan struct{}
}

func newFakeReporter() *fakeReporter { return &fakeReporter{done: make(chan struct{}, 16)} }

func (f *fakeReporter) Complete(_ context.Context, request *contract.CompleteRequest) {
	f.mu.Lock()
	f.completes = append(f.completes, request)
	f.mu.Unlock()
	f.done <- struct{}{}
}

func (f *fakeReporter) Heartbeat(context.Context, *contract.HeartbeatRequest) error {
	f.mu.Lock()
	f.heartbeats++
	f.mu.Unlock()
	return nil
}

func (f *fakeReporter) waitComplete(t *testing.T) *contract.CompleteRequest {
	t.Helper()
	select {
	case <-f.done:
	case <-time.After(5 * time.Second):
		t.Fatal("no completion report")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.completes[len(f.completes)-1]
}

type harness struct {
	control   *fakeControl
	reporter  *fakeReporter
	edge      *httptest.Server
	delegated chan *http.Request
}

func newHarness(t *testing.T, control *fakeControl) *harness {
	t.Helper()
	delegated := make(chan *http.Request, 8)
	delegateSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		delegated <- r
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"delegated":true,"body":` + fmt.Sprintf("%q", string(body)) + `}`))
	}))
	t.Cleanup(delegateSrv.Close)
	delegateURL, _ := url.Parse(delegateSrv.URL)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := &config.Config{
		EdgeID:                 "edge-test",
		MaxBodyBytes:           10 << 20,
		MaxCompressedBodyBytes: 10 << 20,
		MaxJSONDepth:           512,
		MaxConcurrency:         16,
		OverflowToDelegate:     true,
		FallbackToDelegate:     true,
	}
	reporter := newFakeReporter()
	handler := NewHandler(Deps{
		Config:    cfg,
		Control:   control,
		Reporter:  reporter,
		Delegator: delegate.New(delegateURL, logger),
		Upstream:  upstream.NewClient(),
		Budget:    gate.NewBudget(64 << 20),
		Logger:    logger,
	})
	edge := httptest.NewServer(handler)
	t.Cleanup(edge.Close)
	return &harness{control: control, reporter: reporter, edge: edge, delegated: delegated}
}

func (h *harness) post(t *testing.T, path, body string, headers map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, h.edge.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func baseStep(upstreamURL string, streaming bool) *contract.ExecutionStep {
	return &contract.ExecutionStep{
		StepID:                  "1:1:1",
		AttemptNumber:           1,
		TotalProvidersAttempted: 1,
		AttemptKind:             "normal",
		Provider:                contract.StepProvider{ID: 9, Name: "p9", Type: "claude"},
		Method:                  "POST",
		URL:                     upstreamURL,
		Headers: []contract.HeaderPair{
			{"content-type", "application/json"},
			{"x-api-key", "sk-upstream"},
		},
		BodyOps: []contract.BodyOp{
			{Op: contract.OpSetTopLevel, Key: "model", Value: json.RawMessage(`"claude-redirected"`)},
			{Op: contract.OpStripPrivateParams},
		},
		IsStreaming: streaming,
		Timeouts:    contract.StepTimeouts{ConnectMs: 2000, HeadersMs: 5000, BodyMs: 5000},
		Gate:        contract.StepGate{Mode: "enforce", EventCap: 64, ByteCap: 1 << 20, CaptureCommitMarker: true},
		Fixer:       contract.StepFixer{Enabled: true, FixTruncatedJSON: true, FixSseFormat: true, FixEncoding: true, MaxJSONDepth: 200, MaxFixSize: 1 << 20},
		Reporting: contract.StepReporting{
			MaxCompactBytes: 256 << 10, MaxHeadBytes: 1 << 20, MaxNonStreamBodyBytes: 8 << 20,
			MaxErrorBodyBytes: 64 << 10, HeartbeatIntervalMs: 60_000,
		},
		ClientAbortDrainMs: 2000,
	}
}

func executeDecision(step *contract.ExecutionStep) func(*contract.RequestDigest) (*contract.DecideResponse, error) {
	return func(*contract.RequestDigest) (*contract.DecideResponse, error) {
		return &contract.DecideResponse{Action: "execute", RequestID: 1, EdgeToken: "tok", Step: step}, nil
	}
}

const sseStream = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"claude-x\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n" +
	"event: ping\ndata: {\"type\":\"ping\"}\n\n" +
	"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" +
	"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n" +
	"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n" +
	"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n" +
	"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

func TestStaticRoutesAreDelegated(t *testing.T) {
	h := newHarness(t, &fakeControl{})
	resp := h.post(t, "/v1/embeddings", `{"x":1}`, map[string]string{"X-Cch-Internal": "spoof"})
	defer resp.Body.Close()
	if resp.Header.Get(delegate.ReasonHeader) != "static_route" {
		t.Fatalf("expected static delegate, headers %v", resp.Header)
	}
	forwarded := <-h.delegated
	if forwarded.URL.Path != "/v1/embeddings" || forwarded.Header.Get("X-Cch-Internal") != "" {
		t.Fatalf("unexpected forwarded request %s %v", forwarded.URL.Path, forwarded.Header)
	}
	if len(h.control.digests) != 0 {
		t.Fatal("decide must not be called for static routes")
	}
}

func TestDecideDelegateReplaysOriginalBytes(t *testing.T) {
	control := &fakeControl{decide: func(*contract.RequestDigest) (*contract.DecideResponse, error) {
		return &contract.DecideResponse{Action: "delegate", Reason: "hedge_pending"}, nil
	}}
	h := newHarness(t, control)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write([]byte(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	_ = zw.Close()
	req, _ := http.NewRequest(http.MethodPost, h.edge.URL+"/messages?beta=true", bytes.NewReader(gz.Bytes()))
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get(delegate.ReasonHeader) != "hedge_pending" {
		t.Fatalf("headers %v", resp.Header)
	}
	forwarded := <-h.delegated
	body, _ := io.ReadAll(forwarded.Body)
	if !bytes.Equal(body, gz.Bytes()) || forwarded.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("delegate must forward the original compressed bytes")
	}
	if strings.Contains(forwarded.Header.Get("X-Forwarded-For"), "6.6.6.6") {
		t.Fatal("client supplied X-Forwarded-For must not reach the control plane")
	}

	digest := control.digests[0]
	if digest.Path != "/v1/messages?beta=true" || digest.MessagesCount == nil || *digest.MessagesCount != 1 {
		t.Fatalf("unexpected digest path=%s count=%v", digest.Path, digest.MessagesCount)
	}
	for _, pair := range digest.Headers {
		if pair[0] == "content-encoding" {
			t.Fatal("decoded body must not advertise content-encoding in the digest")
		}
		if pair[0] == "x-forwarded-for" && pair[1] == "6.6.6.6" {
			t.Fatal("spoofed forwarding header leaked into the digest")
		}
	}
}

func TestDecideFailIsRelayedVerbatim(t *testing.T) {
	control := &fakeControl{decide: func(*contract.RequestDigest) (*contract.DecideResponse, error) {
		return &contract.DecideResponse{Action: "fail", Response: &contract.FailResponse{
			Status:   401,
			Headers:  []contract.HeaderPair{{"content-type", "application/json; charset=utf-8"}},
			BodyText: `{"error":{"message":"bad key","type":"authentication_error","code":"authentication_error"}}`,
		}}, nil
	}}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","messages":[]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 401 || string(body) != `{"error":{"message":"bad key","type":"authentication_error","code":"authentication_error"}}` {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

func TestControlPlaneOutageFallsBackToDelegate(t *testing.T) {
	control := &fakeControl{decide: func(*contract.RequestDigest) (*contract.DecideResponse, error) {
		return nil, fmt.Errorf("connection refused")
	}}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","messages":[]}`, nil)
	defer resp.Body.Close()
	if resp.Header.Get(delegate.ReasonHeader) != "control_unreachable" {
		t.Fatalf("headers %v", resp.Header)
	}
}

func TestStreamingExecutionCommitsAndReports(t *testing.T) {
	var upstreamBody string
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		upstreamBody = string(data)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Request-Id", "req_up")
		flusher := w.(http.Flusher)
		for _, frame := range strings.SplitAfter(sseStream, "\n\n") {
			_, _ = w.Write([]byte(frame))
			flusher.Flush()
		}
	}))
	defer upstreamSrv.Close()

	control := &fakeControl{decide: executeDecision(baseStep(upstreamSrv.URL+"/v1/messages", true))}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"claude-sonnet","stream":true,"_debug":1,"messages":[{"role":"user","content":"hi"}]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != sseStream {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if resp.Header.Get("Request-Id") != "req_up" {
		t.Fatalf("upstream headers not relayed: %v", resp.Header)
	}
	if upstreamBody != `{"model":"claude-redirected","stream":true,"messages":[{"role":"user","content":"hi"}]}` {
		t.Fatalf("body ops not applied: %s", upstreamBody)
	}

	report := h.reporter.waitComplete(t)
	winner := report.Winner
	if !winner.IsStreaming || !winner.StreamEndedNormally || winner.ClientAborted || winner.UpstreamStatus != 200 {
		t.Fatalf("unexpected winner %+v", winner)
	}
	if !strings.Contains(winner.CompactSSE, "message_start") || !strings.Contains(winner.CompactSSE, "\"output_tokens\":7") {
		t.Fatalf("compact sse missing usage frames: %q", winner.CompactSSE)
	}
	if strings.Contains(winner.CompactSSE, "text_delta") {
		t.Fatalf("compact sse must drop content frames: %q", winner.CompactSSE)
	}
	if winner.GateCommit == nil || winner.Protocol == nil || !winner.Protocol.SawTerminal {
		t.Fatalf("missing gate/protocol observation: %+v %+v", winner.GateCommit, winner.Protocol)
	}
	if winner.Timing.FirstByteAtMs == nil || winner.Timing.FirstTokenAtMs == nil {
		t.Fatal("missing timing marks")
	}
	if winner.BytesToClient != int64(len(sseStream)) {
		t.Fatalf("bytes to client %d", winner.BytesToClient)
	}
}

func TestPreCommitFailureRetriesViaNext(t *testing.T) {
	var calls int
	var mu sync.Mutex
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		attempt := calls
		mu.Unlock()
		if attempt == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(529)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		// Error frame before content: the gate must reject it with zero client bytes.
		if attempt == 2 {
			_, _ = w.Write([]byte("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"boom\"}}\n\n"))
			return
		}
		_, _ = w.Write([]byte(sseStream))
	}))
	defer upstreamSrv.Close()

	first := baseStep(upstreamSrv.URL, true)
	control := &fakeControl{decide: executeDecision(first)}
	control.next = func(request *contract.NextRequest) (*contract.NextResponse, error) {
		retry := baseStep(upstreamSrv.URL, true)
		retry.StepID = fmt.Sprintf("1:1:%d", len(control.nextRequests())+1)
		return &contract.NextResponse{Action: "retry", Step: retry}, nil
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != sseStream {
		t.Fatalf("client must only see the committed stream, got %q", body)
	}
	nexts := control.nextRequests()
	if len(nexts) != 2 {
		t.Fatalf("expected 2 next calls, got %d", len(nexts))
	}
	upstreamFailure := nexts[0].Event.Failure
	if upstreamFailure.Kind != "upstream_status" || upstreamFailure.Status != 529 || !strings.Contains(upstreamFailure.BodyText, "Overloaded") {
		t.Fatalf("unexpected first failure %+v", upstreamFailure)
	}
	gateFailure := nexts[1].Event.Failure
	if gateFailure.Kind != "gate" || gateFailure.Reason != "gate_error" || !strings.Contains(gateFailure.FrameData, "boom") {
		t.Fatalf("unexpected gate failure %+v", gateFailure)
	}
	if !nexts[0].Event.Dispatched {
		t.Fatal("dispatch flag missing")
	}
	report := h.reporter.waitComplete(t)
	if report.Winner.StepID != "1:1:3" {
		t.Fatalf("winner step %s", report.Winner.StepID)
	}
}

func TestNextFailIsRelayed(t *testing.T) {
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"prompt too long"}}`))
	}))
	defer upstreamSrv.Close()
	control := &fakeControl{decide: executeDecision(baseStep(upstreamSrv.URL, false))}
	control.next = func(*contract.NextRequest) (*contract.NextResponse, error) {
		return &contract.NextResponse{Action: "fail", Response: &contract.FailResponse{
			Status: 400, Headers: []contract.HeaderPair{{"content-type", "application/json"}}, BodyText: `{"error":{"message":"prompt too long (cch_session_id: s)"}}`,
		}}, nil
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","messages":[]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 400 || !strings.Contains(string(body), "cch_session_id") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

func TestFirstByteTimeoutReportsTimeout(t *testing.T) {
	release := make(chan struct{})
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer upstreamSrv.Close()
	defer close(release)
	step := baseStep(upstreamSrv.URL, true)
	step.Timeouts.FirstByteMs = 100
	step.Gate.Mode = "off"
	control := &fakeControl{decide: executeDecision(step)}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[]}`, nil)
	defer resp.Body.Close()
	_, _ = io.ReadAll(resp.Body)
	nexts := control.nextRequests()
	if len(nexts) != 1 || nexts[0].Event.Failure.Kind != "timeout" || nexts[0].Event.Failure.TimeoutType != "streaming_first_byte" {
		t.Fatalf("unexpected events %+v", nexts)
	}
}

func TestNonStreamExecutionAndSuspectReview(t *testing.T) {
	responses := []string{
		"<!DOCTYPE html><html><body>Cloudflare error</body></html>",
		`{"type":"message","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":2}}`,
	}
	var index int
	var mu sync.Mutex
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		body := responses[index]
		index++
		mu.Unlock()
		if strings.HasPrefix(body, "<") {
			w.Header().Set("Content-Type", "text/html")
		} else {
			w.Header().Set("Content-Type", "application/json")
		}
		_, _ = w.Write([]byte(body))
	}))
	defer upstreamSrv.Close()

	control := &fakeControl{decide: executeDecision(baseStep(upstreamSrv.URL, false))}
	control.next = func(request *contract.NextRequest) (*contract.NextResponse, error) {
		if request.Event.Type != "suspect_2xx" {
			t.Errorf("unexpected event %s", request.Event.Type)
		}
		retry := baseStep(upstreamSrv.URL, false)
		retry.StepID = "1:1:2"
		return &contract.NextResponse{Action: "retry", Step: retry}, nil
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","messages":[]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != responses[1] {
		t.Fatalf("body %s", body)
	}
	report := h.reporter.waitComplete(t)
	if report.Winner.IsStreaming || report.Winner.NonStreamBody == nil || report.Winner.NonStreamBody.Text != responses[1] {
		t.Fatalf("unexpected report %+v", report.Winner)
	}
}

func TestClientDisconnectAfterCommitDrainsForUsage(t *testing.T) {
	head := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\n\n"
	tail := "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	clientGone := make(chan struct{})
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(head))
		w.(http.Flusher).Flush()
		<-clientGone
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(tail))
	}))
	defer upstreamSrv.Close()

	control := &fakeControl{decide: executeDecision(baseStep(upstreamSrv.URL, true))}
	h := newHarness(t, control)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.edge.URL+"/v1/messages", strings.NewReader(`{"model":"m","stream":true,"messages":[]}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	_, _ = resp.Body.Read(buf)
	cancel()
	_ = resp.Body.Close()
	close(clientGone)

	report := h.reporter.waitComplete(t)
	if !report.Winner.ClientAborted {
		t.Fatalf("expected client abort, got %+v", report.Winner)
	}
	if !strings.Contains(report.Winner.CompactSSE, "\"output_tokens\":9") {
		t.Fatalf("drain must capture final usage, got %q", report.Winner.CompactSSE)
	}
}
