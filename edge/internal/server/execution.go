package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/bodyops"
	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/delegate"
	"github.com/ding113/claude-code-hub/edge/internal/detect"
	"github.com/ding113/claude-code-hub/edge/internal/fixer"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
	"github.com/ding113/claude-code-hub/edge/internal/upstream"
)

var (
	errFirstByteTimeout = errors.New("first byte timeout")
	errTotalTimeout     = errors.New("non-streaming total timeout")
	errClientAborted    = errors.New("client aborted before commit")
)

// Response headers never relayed to the client (recomputed by net/http or stripped
// by the local response fixer).
var skippedResponseHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "transfer-encoding": true, "te": true,
	"upgrade": true, "content-length": true, "content-encoding": true,
	"proxy-authenticate": true, "trailer": true, "x-cch-response-fixer": true,
}

type execution struct {
	h         *Handler
	w         http.ResponseWriter
	r         *http.Request
	raw       []byte
	body      *ojson.Value
	requestID int64
	edgeToken string
	startedAt time.Time

	mu             sync.Mutex
	bytesForwarded int64
}

// attemptResult is what a single attempt produced before commit.
type attemptResult struct {
	committed bool
	// event is set when the attempt failed (or needs control-plane review) before commit.
	event *contract.NextEvent
	// verdict is set when the control plane already answered for this attempt
	// (suspect 2xx review) and the outer loop must act on it.
	verdict *contract.NextResponse
}

func (e *execution) run(first *contract.ExecutionStep) {
	h := e.h
	h.metrics.inflight.Add(1)
	defer h.metrics.inflight.Add(-1)

	heartbeatCtx, stopHeartbeat := context.WithCancel(h.baseCtx)
	defer stopHeartbeat()
	go e.heartbeatLoop(heartbeatCtx, first.Reporting.HeartbeatIntervalMs)

	step := first
	for step != nil {
		if step.DelayMs > 0 && !sleepCtx(e.r.Context(), time.Duration(step.DelayMs)*time.Millisecond) {
			e.reportClientAbort(step)
			return
		}
		h.metrics.attempts.Add("started", 1)
		result := e.attempt(step)
		if result.committed {
			return
		}
		next := result.verdict
		if next == nil {
			if result.event == nil {
				return
			}
			var err error
			next, err = e.next(step, result.event)
			if err != nil {
				h.logger.Warn("next failed", "requestId", e.requestID, "stepId", step.StepID, "error", err)
				if e.r.Context().Err() == nil {
					delegate.WriteError(e.w, http.StatusBadGateway, "edge control plane unavailable", "bad_gateway_error")
				}
				return
			}
		}
		switch next.Action {
		case "retry", "launch":
			step = next.Step
		case "fail":
			if e.r.Context().Err() == nil {
				writeFailResponse(e.w, next.Response)
			}
			return
		case "delegate":
			h.delegator.Serve(e.w, e.r, e.raw, "control_plane_delegate")
			return
		default:
			h.logger.Warn("unexpected next action", "action", next.Action)
			delegate.WriteError(e.w, http.StatusBadGateway, "invalid control plane response", "bad_gateway_error")
			return
		}
	}
}

func (e *execution) next(step *contract.ExecutionStep, event *contract.NextEvent) (*contract.NextResponse, error) {
	// The client may already be gone; the control plane must still settle the request.
	ctx := context.WithoutCancel(e.r.Context())
	return e.h.control.Next(ctx, &contract.NextRequest{
		RequestID: e.requestID,
		EdgeToken: e.edgeToken,
		StepID:    step.StepID,
		Event:     *event,
	})
}

func (e *execution) heartbeatLoop(ctx context.Context, intervalMs int64) {
	if intervalMs <= 0 {
		intervalMs = 15_000
	}
	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.mu.Lock()
			forwarded := e.bytesForwarded
			e.mu.Unlock()
			_ = e.h.reporter.Heartbeat(ctx, &contract.HeartbeatRequest{
				RequestID:      e.requestID,
				EdgeToken:      e.edgeToken,
				BytesForwarded: forwarded,
			})
		}
	}
}

func (e *execution) reportClientAbort(step *contract.ExecutionStep) {
	now := time.Now().UnixMilli()
	_, _ = e.next(step, &contract.NextEvent{
		Type:    "failure",
		Failure: &contract.AttemptFailure{Kind: "client_abort"},
		Timing:  &contract.AttemptTiming{EndedAtMs: now},
	})
}

// attemptTimers tracks dispatch and first-byte instants for health attribution.
type attemptTimers struct {
	mu           sync.Mutex
	dispatchedAt time.Time
	firstByteAt  time.Time
}

func (t *attemptTimers) markDispatched() {
	t.mu.Lock()
	if t.dispatchedAt.IsZero() {
		t.dispatchedAt = time.Now()
	}
	t.mu.Unlock()
}

func (t *attemptTimers) markFirstByte() {
	t.mu.Lock()
	if t.firstByteAt.IsZero() {
		t.firstByteAt = time.Now()
	}
	t.mu.Unlock()
}

func (t *attemptTimers) snapshot() (dispatched, firstByte time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dispatchedAt, t.firstByteAt
}

func msPtr(at time.Time) *int64 {
	if at.IsZero() {
		return nil
	}
	value := at.UnixMilli()
	return &value
}

func (t *attemptTimers) timing() *contract.AttemptTiming {
	dispatched, firstByte := t.snapshot()
	now := time.Now()
	elapsed := int64(0)
	if !dispatched.IsZero() {
		elapsed = now.Sub(dispatched).Milliseconds()
	}
	return &contract.AttemptTiming{
		DispatchedAtMs:  msPtr(dispatched),
		FirstByteAtMs:   msPtr(firstByte),
		EndedAtMs:       now.UnixMilli(),
		HealthElapsedMs: elapsed,
	}
}

func (e *execution) failureEvent(failure contract.AttemptFailure, timers *attemptTimers, opResults *contract.OpResults) *contract.NextEvent {
	dispatched, firstByte := timers.snapshot()
	e.h.metrics.attempts.Add("failed_"+failure.Kind, 1)
	return &contract.NextEvent{
		Type:          "failure",
		Failure:       &failure,
		Dispatched:    !dispatched.IsZero(),
		FirstByteSeen: !firstByte.IsZero(),
		Timing:        timers.timing(),
		OpResults:     opResults,
	}
}

// classifyAttemptError maps an attempt error to a failure, honoring which of our
// own timers (or the client) cancelled the attempt.
func (e *execution) classifyAttemptError(ctx context.Context, err error, gateActive bool) contract.AttemptFailure {
	if e.r.Context().Err() != nil || errors.Is(context.Cause(ctx), errClientAborted) {
		return contract.AttemptFailure{Kind: "client_abort"}
	}
	switch cause := context.Cause(ctx); {
	case errors.Is(cause, errFirstByteTimeout):
		if gateActive {
			return contract.AttemptFailure{Kind: "timeout", TimeoutType: "streaming_first_valid_content"}
		}
		return contract.AttemptFailure{Kind: "timeout", TimeoutType: "streaming_first_byte"}
	case errors.Is(cause, errTotalTimeout):
		return contract.AttemptFailure{Kind: "timeout", TimeoutType: "non_streaming_total"}
	}
	code, message := upstream.ClassifyError(err)
	e.h.metrics.upstreamErrors.Add(code, 1)
	return contract.AttemptFailure{Kind: "transport", Code: code, Message: message}
}

func hasSignatureRectifier(ops []contract.BodyOp) bool {
	for _, op := range ops {
		if op.Op == contract.OpApplyThinkingSignatureRectifier {
			return true
		}
	}
	return false
}

func nonEmptyOpResults(results contract.OpResults) *contract.OpResults {
	if results.BillingHeader == nil && results.ThinkingSignature == nil {
		return nil
	}
	return &results
}

func (e *execution) attempt(step *contract.ExecutionStep) attemptResult {
	timers := &attemptTimers{}

	transformed, opResultsValue, err := bodyops.Apply(e.body, step.BodyOps)
	if err != nil {
		return attemptResult{event: e.failureEvent(contract.AttemptFailure{Kind: "invalid_step", Message: err.Error()}, timers, nil)}
	}
	opResults := nonEmptyOpResults(opResultsValue)
	if hasSignatureRectifier(step.BodyOps) && opResultsValue.ThinkingSignature != nil &&
		!opResultsValue.ThinkingSignature.Applied {
		return attemptResult{event: &contract.NextEvent{Type: "rectifier_not_applicable", OpResults: opResults}}
	}
	requestBody := transformed.Marshal()

	// The upstream request must survive a client disconnect after commit (usage is
	// still drained for billing), so it is detached from the client context and only
	// cancelled by the client before commit.
	attemptCtx, cancel := context.WithCancelCause(context.WithoutCancel(e.r.Context()))
	defer cancel(nil)
	var committed atomic.Bool
	stopClientWatch := context.AfterFunc(e.r.Context(), func() {
		if !committed.Load() {
			cancel(errClientAborted)
		}
	})
	defer stopClientWatch()
	markCommitted := func() { committed.Store(true) }

	var firstByteTimer *time.Timer
	if step.IsStreaming && step.Timeouts.FirstByteMs > 0 {
		firstByteTimer = time.AfterFunc(time.Duration(step.Timeouts.FirstByteMs)*time.Millisecond, func() {
			cancel(errFirstByteTimeout)
		})
	}
	if !step.IsStreaming && step.Timeouts.NonStreamTotalMs > 0 {
		totalTimer := time.AfterFunc(time.Duration(step.Timeouts.NonStreamTotalMs)*time.Millisecond, func() {
			cancel(errTotalTimeout)
		})
		defer totalTimer.Stop()
	}
	stopFirstByteTimer := func() {
		if firstByteTimer != nil {
			firstByteTimer.Stop()
		}
	}
	defer stopFirstByteTimer()

	result, err := e.h.upstream.Do(attemptCtx, step, requestBody, timers.markDispatched)
	if err != nil {
		return attemptResult{event: e.failureEvent(e.classifyAttemptError(attemptCtx, err, false), timers, opResults)}
	}
	resp := result.Response
	defer func() {
		// Owned by the stream relay after commit; otherwise release it here.
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyText, truncated := readErrorBody(resp.Body, step.Reporting.MaxErrorBodyBytes)
		timers.markFirstByte()
		return attemptResult{event: e.failureEvent(contract.AttemptFailure{
			Kind:          "upstream_status",
			Status:        resp.StatusCode,
			StatusText:    http.StatusText(resp.StatusCode),
			Headers:       headerPairs(resp.Header),
			BodyText:      bodyText,
			BodyTruncated: truncated,
		}, timers, opResults)}
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		return e.handleStream(attemptCtx, step, resp, timers, stopFirstByteTimer, markCommitted, opResults)
	}
	return e.handleNonStream(attemptCtx, step, resp, timers, markCommitted, opResults)
}

func readErrorBody(body io.Reader, limit int) (string, bool) {
	if limit <= 0 {
		limit = 64 << 10
	}
	data, _ := io.ReadAll(io.LimitReader(body, int64(limit)+1))
	truncated := len(data) > limit
	if truncated {
		data = data[:limit]
	}
	return strings.ToValidUTF8(string(data), "�"), truncated
}

func headerPairs(header http.Header) []contract.HeaderPair {
	pairs := make([]contract.HeaderPair, 0, len(header))
	for name, values := range header {
		lower := strings.ToLower(name)
		for _, value := range values {
			pairs = append(pairs, contract.HeaderPair{lower, value})
		}
	}
	return pairs
}

func (e *execution) writeResponseHeaders(resp *http.Response) {
	header := e.w.Header()
	for name, values := range resp.Header {
		if skippedResponseHeaders[strings.ToLower(name)] {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	e.w.WriteHeader(resp.StatusCode)
}

func (e *execution) handleNonStream(ctx context.Context, step *contract.ExecutionStep, resp *http.Response, timers *attemptTimers, markCommitted func(), opResults *contract.OpResults) attemptResult {
	if resp.ContentLength == 0 {
		return attemptResult{event: e.failureEvent(contract.AttemptFailure{Kind: "empty_response", Reason: "empty_body"}, timers, opResults)}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, e.h.cfg.MaxBodyBytes+1))
	if err != nil {
		return attemptResult{event: e.failureEvent(e.classifyAttemptError(ctx, err, false), timers, opResults)}
	}
	if len(data) > 0 {
		timers.markFirstByte()
	}
	if reason := detect.EmptyReason(data); reason != "" && resp.ContentLength < 0 {
		return attemptResult{event: e.failureEvent(contract.AttemptFailure{Kind: "empty_response", Reason: reason}, timers, opResults)}
	}
	if detect.SuspectNonStream(data, resp.Header.Get("Content-Type")) {
		limit := step.Reporting.MaxErrorBodyBytes
		text := string(data)
		truncated := false
		if limit > 0 && len(text) > limit {
			text = text[:limit]
			truncated = true
		}
		verdict, err := e.next(step, &contract.NextEvent{
			Type:          "suspect_2xx",
			Status:        resp.StatusCode,
			Headers:       headerPairs(resp.Header),
			BodyText:      strings.ToValidUTF8(text, "�"),
			BodyTruncated: truncated,
			OpResults:     opResults,
		})
		if err != nil {
			e.h.logger.Warn("suspect review failed", "requestId", e.requestID, "error", err)
			if e.r.Context().Err() == nil {
				delegate.WriteError(e.w, http.StatusBadGateway, "edge control plane unavailable", "bad_gateway_error")
			}
			return attemptResult{committed: true}
		}
		if verdict.Action != "commit" {
			return attemptResult{verdict: verdict}
		}
	}

	var fixerAudit *contract.FixerAudit
	clientBody := data
	if step.Fixer.Enabled {
		fixed, audit := fixer.FixNonStream(data, fixerConfig(step))
		clientBody = fixed
		if audit.Hit {
			fixerAudit = &audit
		}
	}

	markCommitted()
	e.writeResponseHeaders(resp)
	written, _ := e.w.Write(clientBody)
	e.addForwarded(int64(written))

	dispatched, firstByte := timers.snapshot()
	storedLimit := step.Reporting.MaxNonStreamBodyBytes
	storedText := string(data)
	storedTruncated := false
	if storedLimit > 0 && len(storedText) > storedLimit {
		storedText = storedText[:storedLimit]
		storedTruncated = true
	}
	e.h.reporter.Complete(e.h.baseCtx, &contract.CompleteRequest{
		RequestID: e.requestID,
		EdgeToken: e.edgeToken,
		Winner: contract.WinnerResult{
			StepID:              step.StepID,
			UpstreamStatus:      resp.StatusCode,
			ResponseHeaders:     headerPairs(resp.Header),
			IsStreaming:         false,
			StreamEndedNormally: true,
			FirstByteSeen:       !firstByte.IsZero(),
			NonStreamBody:       &contract.NonStreamBody{Text: strings.ToValidUTF8(storedText, "�"), Truncated: storedTruncated},
			Fixer:               fixerAudit,
			Timing: contract.WinnerTiming{
				DispatchedAtMs:  dispatched.UnixMilli(),
				FirstByteAtMs:   msPtr(firstByte),
				EndedAtMs:       time.Now().UnixMilli(),
				HealthElapsedMs: time.Since(dispatched).Milliseconds(),
			},
			BytesToClient: int64(written),
			OpResults:     opResults,
		},
		Losers: []contract.LoserResult{},
	})
	e.h.metrics.attempts.Add("committed_non_stream", 1)
	return attemptResult{committed: true}
}

func fixerConfig(step *contract.ExecutionStep) fixer.Config {
	return fixer.Config{
		FixTruncatedJSON: step.Fixer.FixTruncatedJSON,
		FixSseFormat:     step.Fixer.FixSseFormat,
		FixEncoding:      step.Fixer.FixEncoding,
		MaxJSONDepth:     step.Fixer.MaxJSONDepth,
		MaxFixSize:       step.Fixer.MaxFixSize,
	}
}

func (e *execution) addForwarded(bytes int64) {
	e.mu.Lock()
	e.bytesForwarded += bytes
	e.mu.Unlock()
	e.h.metrics.bytesToClient.Add(bytes)
}

func sleepCtx(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
