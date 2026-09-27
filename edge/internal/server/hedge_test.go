package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
)

func hedgeStep(stepID, upstreamURL string, providerID int64, billLosers bool) *contract.ExecutionStep {
	step := baseStep(upstreamURL, true)
	step.StepID = stepID
	step.Provider.ID = providerID
	step.Hedge = &contract.StepHedge{ThresholdMs: 60, MaxInFlight: 2, BillLosers: billLosers, LoserDrainMs: 2000}
	return step
}

// sseUpstream serves sseStream after delay; cancelled records a client-side abort.
func sseUpstream(t *testing.T, delay time.Duration, cancelled *atomic.Bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			if cancelled != nil {
				cancelled.Store(true)
			}
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		for _, frame := range strings.SplitAfter(sseStream, "\n\n") {
			if _, err := w.Write([]byte(frame)); err != nil {
				if cancelled != nil {
					cancelled.Store(true)
				}
				return
			}
			flusher.Flush()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHedgeThresholdLaunchesAlternativeAndCancelsLoser(t *testing.T) {
	var slowCancelled atomic.Bool
	slow := sseUpstream(t, 2*time.Second, &slowCancelled)
	fast := sseUpstream(t, 0, nil)

	control := &fakeControl{
		decide: executeDecision(hedgeStep("1:h1:1", slow.URL, 1, false)),
		next: func(request *contract.NextRequest) (*contract.NextResponse, error) {
			if request.Event.Type == "hedge_threshold" {
				return &contract.NextResponse{Action: "launch", Step: hedgeStep("1:h2:1", fast.URL, 2, false)}, nil
			}
			return &contract.NextResponse{Action: "wait"}, nil
		},
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != sseStream {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}

	report := h.reporter.waitComplete(t)
	if report.Winner.StepID != "1:h2:1" {
		t.Fatalf("winner %s", report.Winner.StepID)
	}
	if len(report.Losers) != 1 || report.Losers[0].StepID != "1:h1:1" || report.Losers[0].MeteringText != "" {
		t.Fatalf("unexpected losers %+v", report.Losers)
	}
	nexts := control.nextRequests()
	if len(nexts) != 1 || nexts[0].Event.Type != "hedge_threshold" || nexts[0].StepID != "1:h1:1" {
		t.Fatalf("unexpected next calls %+v", nexts)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !slowCancelled.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !slowCancelled.Load() {
		t.Fatal("loser upstream request was not cancelled")
	}
}

func TestHedgeLoserIsDrainedForBilling(t *testing.T) {
	slow := sseUpstream(t, 250*time.Millisecond, nil)
	fast := sseUpstream(t, 0, nil)

	control := &fakeControl{
		decide: executeDecision(hedgeStep("1:h1:1", slow.URL, 1, true)),
		next: func(request *contract.NextRequest) (*contract.NextResponse, error) {
			if request.Event.Type == "hedge_threshold" {
				return &contract.NextResponse{Action: "launch", Step: hedgeStep("1:h2:1", fast.URL, 2, true)}, nil
			}
			return &contract.NextResponse{Action: "wait"}, nil
		},
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()

	report := h.reporter.waitComplete(t)
	if report.Winner.StepID != "1:h2:1" || len(report.Losers) != 1 {
		t.Fatalf("unexpected report %+v", report)
	}
	loser := report.Losers[0]
	if loser.UpstreamStatus != 200 || !loser.DrainComplete {
		t.Fatalf("loser not drained: %+v", loser)
	}
	if !strings.Contains(loser.MeteringText, `"output_tokens":7`) {
		t.Fatalf("loser metering text missing usage: %q", loser.MeteringText)
	}
}

func TestHedgeFailureWaitsForPeer(t *testing.T) {
	slow := sseUpstream(t, 200*time.Millisecond, nil)
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	}))
	defer failing.Close()

	control := &fakeControl{
		decide: executeDecision(hedgeStep("1:h1:1", slow.URL, 1, false)),
		next: func(request *contract.NextRequest) (*contract.NextResponse, error) {
			switch request.Event.Type {
			case "hedge_threshold":
				return &contract.NextResponse{Action: "launch", Step: hedgeStep("1:h2:1", failing.URL, 2, false)}, nil
			case "failure":
				return &contract.NextResponse{Action: "wait"}, nil
			}
			return &contract.NextResponse{Action: "none"}, nil
		},
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != sseStream {
		t.Fatalf("body %q", body)
	}
	report := h.reporter.waitComplete(t)
	if report.Winner.StepID != "1:h1:1" || len(report.Losers) != 0 {
		t.Fatalf("unexpected report winner=%s losers=%+v", report.Winner.StepID, report.Losers)
	}
	nexts := control.nextRequests()
	if len(nexts) != 2 || nexts[1].Event.Type != "failure" || nexts[1].StepID != "1:h2:1" ||
		nexts[1].Event.Failure.Status != 500 {
		t.Fatalf("unexpected next calls %+v", nexts)
	}
}

func TestHedgeFailCancelsEveryAttempt(t *testing.T) {
	var slowCancelled atomic.Bool
	slow := sseUpstream(t, 2*time.Second, &slowCancelled)
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"bad"}}`))
	}))
	defer failing.Close()

	control := &fakeControl{
		decide: executeDecision(hedgeStep("1:h1:1", slow.URL, 1, false)),
		next: func(request *contract.NextRequest) (*contract.NextResponse, error) {
			if request.Event.Type == "hedge_threshold" {
				return &contract.NextResponse{Action: "launch", Step: hedgeStep("1:h2:1", failing.URL, 2, false)}, nil
			}
			return &contract.NextResponse{Action: "fail", Response: &contract.FailResponse{
				Status: 400, Headers: []contract.HeaderPair{{"content-type", "application/json"}}, BodyText: `{"error":"bad"}`,
			}}, nil
		},
	}
	h := newHarness(t, control)
	resp := h.post(t, "/v1/messages", `{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 || string(body) != `{"error":"bad"}` {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !slowCancelled.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !slowCancelled.Load() {
		t.Fatal("in-flight attempt was not cancelled")
	}
}

func TestHedgeClientAbortReportsPeers(t *testing.T) {
	hang := sseUpstream(t, 5*time.Second, nil)
	abortSeen := make(chan *contract.NextRequest, 1)
	var launched atomic.Bool
	control := &fakeControl{
		decide: executeDecision(hedgeStep("1:h1:1", hang.URL, 1, false)),
		next: func(request *contract.NextRequest) (*contract.NextResponse, error) {
			if request.Event.Type == "hedge_threshold" {
				// The control plane stops launching at maxInFlight (2).
				if launched.Swap(true) {
					return &contract.NextResponse{Action: "none"}, nil
				}
				return &contract.NextResponse{Action: "launch", Step: hedgeStep("1:h2:1", hang.URL, 2, false)}, nil
			}
			if request.Event.Failure != nil && request.Event.Failure.Kind == "client_abort" {
				abortSeen <- request
			}
			return &contract.NextResponse{Action: "fail", Response: &contract.FailResponse{Status: 499, BodyText: "{}"}}, nil
		},
	}
	h := newHarness(t, control)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.edge.URL+"/v1/messages",
		strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	go func() {
		// Wait until both attempts are in flight (threshold 60ms, launch answered).
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}

	select {
	case request := <-abortSeen:
		if len(request.Event.Peers) != 1 || !request.Event.Peers[0].Dispatched || request.Event.Peers[0].FirstByteSeen {
			t.Fatalf("unexpected peers %+v", request.Event.Peers)
		}
		if request.Event.Peers[0].StepID == request.StepID {
			t.Fatalf("reporter listed as its own peer: %s", request.StepID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("client abort was not reported")
	}
}
