package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/capture"
	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/fixer"
	"github.com/ding113/claude-code-hub/edge/internal/gate"
)

const readChunkSize = 32 << 10

type chunk struct {
	data []byte
	err  error
}

// chunkReader reads the upstream body on a goroutine so reads can race timers.
// Closing the body unblocks a pending read.
type chunkReader struct {
	ch   chan chunk
	stop chan struct{}
}

func newChunkReader(body io.Reader) *chunkReader {
	reader := &chunkReader{ch: make(chan chunk, 1), stop: make(chan struct{})}
	go func() {
		defer close(reader.ch)
		for {
			buf := make([]byte, readChunkSize)
			n, err := body.Read(buf)
			var data []byte
			if n > 0 {
				data = buf[:n]
			}
			select {
			case reader.ch <- chunk{data: data, err: err}:
			case <-reader.stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return reader
}

func (c *chunkReader) close() { close(c.stop) }

// readerFromChunks adapts prefix chunks + a chunkReader into an io.Reader for the gate.
type gateInput struct {
	reader *chunkReader
	buf    []byte
	err    error
}

func (g *gateInput) Read(p []byte) (int, error) {
	if len(g.buf) > 0 {
		n := copy(p, g.buf)
		g.buf = g.buf[n:]
		return n, nil
	}
	if g.err != nil {
		return 0, g.err
	}
	next, ok := <-g.reader.ch
	if !ok {
		return 0, io.EOF
	}
	if next.err != nil {
		g.err = next.err
	}
	n := copy(p, next.data)
	g.buf = next.data[n:]
	if n == 0 && g.err != nil {
		return 0, g.err
	}
	return n, nil
}

type streamOutcome struct {
	endedNormally bool
	clientAborted bool
	abortReason   *string
}

func strPtr(value string) *string { return &value }

func (e *execution) handleStream(
	ctx context.Context,
	step *contract.ExecutionStep,
	resp *http.Response,
	timers *attemptTimers,
	stopFirstByteTimer func(),
	markCommitted func(),
	opResults *contract.OpResults,
) attemptResult {
	body := resp.Body
	reader := newChunkReader(body)
	defer reader.close()

	var prefix [][]byte
	var commitMarker *contract.GateCommit
	readerDone := false
	gateStarted := time.Now()
	precommit := step.Gate.Mode == "enforce" && !step.Gate.HighConcurrency

	if precommit {
		input := &gateInput{reader: reader}
		result := gate.Run(ctx, input, gate.Options{
			Family:              gate.Family("anthropic"),
			EventCap:            step.Gate.EventCap,
			ByteCap:             step.Gate.ByteCap,
			IdleTimeout:         time.Duration(step.Gate.IdleMs) * time.Millisecond,
			CaptureCommitMarker: step.Gate.CaptureCommitMarker,
			Budget:              e.h.budget,
			OnFirstByte: func() {
				timers.markFirstByte()
				stopFirstByteTimer()
			},
		})
		if !result.Committed {
			return attemptResult{event: e.failureEvent(e.gateFailure(ctx, result), timers, opResults)}
		}
		prefix = result.Prefix
		readerDone = result.ReaderDone
		if result.CommitMarker != nil {
			marker := result.CommitMarker
			commitMarker = &contract.GateCommit{
				FrameIndex:        marker.FrameIndex,
				ChunkIndex:        marker.ChunkIndex,
				EventName:         marker.EventName,
				BufferedBytes:     marker.BufferedBytes,
				EchoExcludedBytes: marker.EchoExcludedBytes,
				GateWaitMs:        time.Since(gateStarted).Milliseconds(),
			}
		}
		// Bytes the gate pulled from the reader but did not consume stay in input.buf.
		if len(input.buf) > 0 {
			prefix = append(prefix, input.buf)
			input.buf = nil
		}
		if input.err != nil {
			readerDone = true
		}
	} else {
		first, ok := e.readFirstChunk(ctx, reader, step)
		if !ok.committed {
			return ok
		}
		timers.markFirstByte()
		stopFirstByteTimer()
		prefix = [][]byte{first.data}
		readerDone = first.err != nil
	}
	firstTokenAt := time.Now()

	// COMMIT POINT: from here on nothing may fail over.
	markCommitted()
	e.h.metrics.attempts.Add("committed_stream", 1)
	e.writeResponseHeaders(resp)
	flusher, _ := e.w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	observer := gate.NewObserver(gate.Family("anthropic"), step.Gate.ByteCap)
	compact := capture.NewCompactCapture(step.Reporting.MaxCompactBytes)
	metering := capture.NewMeteringObserver("claude", 0)
	var streamFixer *fixer.StreamFixer
	if step.Fixer.Enabled {
		streamFixer = fixer.NewStreamFixer(fixerConfig(step))
	}

	var bytesToClient int64
	clientGone := false
	meteringDone := false
	deliver := func(data []byte) {
		if len(data) == 0 {
			return
		}
		if errorSeen, drainComplete := metering.Observe(data); errorSeen || drainComplete {
			meteringDone = true
		}
		out := data
		if streamFixer != nil {
			out = streamFixer.Write(data)
		}
		if len(out) == 0 || clientGone {
			return
		}
		observer.Observe(out)
		compact.Observe(out)
		if _, err := e.w.Write(out); err != nil {
			clientGone = true
			return
		}
		bytesToClient += int64(len(out))
		e.addForwarded(int64(len(out)))
		if flusher != nil {
			flusher.Flush()
		}
	}

	for _, part := range prefix {
		deliver(part)
	}

	outcome := e.relay(step, reader, readerDone, deliver, &clientGone, &meteringDone, metering)

	if streamFixer != nil && !clientGone {
		if tail := streamFixer.Flush(); len(tail) > 0 {
			observer.Observe(tail)
			compact.Observe(tail)
			if _, err := e.w.Write(tail); err == nil {
				bytesToClient += int64(len(tail))
				e.addForwarded(int64(len(tail)))
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}

	compactText, compactTruncated, eventCount := compact.Result()
	observation := observer.Finish()
	protocol := &contract.ProtocolObservation{
		SawContent:            observation.SawContent,
		SawTerminal:           observation.SawTerminal,
		SawIncomplete:         observation.SawIncomplete,
		ObservationIncomplete: observation.ObservationIncomplete,
	}
	if observation.Failure != nil {
		protocol.Failure = &contract.ProtocolFailure{
			Verdict:      observation.Failure.Verdict,
			EventName:    observation.Failure.EventName,
			AfterContent: observation.Failure.AfterContent,
			SawMalformed: observation.Failure.SawMalformed,
		}
	}
	if outcome.clientAborted {
		// Mirrors the local client-abort path: settle from the bounded metering evidence.
		metered := metering.Finish()
		compactText = metered.Text
		protocol = &contract.ProtocolObservation{
			SawContent:            metered.SawContent,
			SawTerminal:           metered.TerminalSeen,
			SawIncomplete:         metered.IncompleteSeen,
			ObservationIncomplete: metered.SkippedOversizedFrames > 0,
			Failure:               metered.ProtocolFailure,
		}
	}

	var fixerAudit *contract.FixerAudit
	if streamFixer != nil {
		if audit := streamFixer.Audit(); audit.Hit {
			fixerAudit = &audit
		}
	}

	dispatched, firstByte := timers.snapshot()
	e.h.reporter.Complete(e.h.baseCtx, &contract.CompleteRequest{
		RequestID: e.requestID,
		EdgeToken: e.edgeToken,
		Winner: contract.WinnerResult{
			StepID:              step.StepID,
			UpstreamStatus:      resp.StatusCode,
			ResponseHeaders:     headerPairs(resp.Header),
			IsStreaming:         true,
			StreamEndedNormally: outcome.endedNormally,
			ClientAborted:       outcome.clientAborted,
			AbortReason:         outcome.abortReason,
			FirstByteSeen:       !firstByte.IsZero(),
			SSEEventCount:       eventCount,
			CompactSSE:          compactText,
			CompactTruncated:    compactTruncated,
			Protocol:            protocol,
			GateCommit:          commitMarker,
			Fixer:               fixerAudit,
			Timing: contract.WinnerTiming{
				DispatchedAtMs:  dispatched.UnixMilli(),
				FirstByteAtMs:   msPtr(firstByte),
				FirstTokenAtMs:  msPtr(firstTokenAt),
				EndedAtMs:       time.Now().UnixMilli(),
				HealthElapsedMs: time.Since(dispatched).Milliseconds(),
			},
			BytesToClient: bytesToClient,
			OpResults:     opResults,
		},
		Losers: []contract.LoserResult{},
	})
	return attemptResult{committed: true}
}

// readFirstChunk waits for the first non-empty chunk when the precommit gate is off.
func (e *execution) readFirstChunk(ctx context.Context, reader *chunkReader, step *contract.ExecutionStep) (chunk, attemptResult) {
	for {
		select {
		case <-ctx.Done():
			return chunk{}, attemptResult{event: e.failureEventFromCtx(ctx, step)}
		case next, ok := <-reader.ch:
			if !ok {
				return chunk{}, attemptResult{event: e.emptyStreamEvent()}
			}
			if len(next.data) > 0 {
				return next, attemptResult{committed: true}
			}
			if next.err != nil {
				if errors.Is(next.err, io.EOF) {
					return chunk{}, attemptResult{event: e.emptyStreamEvent()}
				}
				failure := e.classifyAttemptError(ctx, next.err, false)
				return chunk{}, attemptResult{event: &contract.NextEvent{
					Type: "failure", Failure: &failure, Dispatched: true,
					Timing: &contract.AttemptTiming{EndedAtMs: time.Now().UnixMilli()},
				}}
			}
		}
	}
}

func (e *execution) emptyStreamEvent() *contract.NextEvent {
	return &contract.NextEvent{
		Type:       "failure",
		Failure:    &contract.AttemptFailure{Kind: "empty_response", Reason: "empty_body"},
		Dispatched: true,
		Timing:     &contract.AttemptTiming{EndedAtMs: time.Now().UnixMilli()},
	}
}

func (e *execution) failureEventFromCtx(ctx context.Context, step *contract.ExecutionStep) *contract.NextEvent {
	failure := e.classifyAttemptError(ctx, context.Cause(ctx), false)
	return &contract.NextEvent{
		Type: "failure", Failure: &failure, Dispatched: true,
		Timing: &contract.AttemptTiming{EndedAtMs: time.Now().UnixMilli()},
	}
}

func (e *execution) gateFailure(ctx context.Context, result gate.Result) contract.AttemptFailure {
	if result.Failure == nil {
		err := result.ReadErr
		if err == nil {
			err = context.Cause(ctx)
		}
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return e.classifyAttemptError(ctx, err, true)
	}
	failure := result.Failure
	switch failure.Reason {
	case "idle_timeout":
		return contract.AttemptFailure{Kind: "timeout", TimeoutType: "streaming_idle"}
	case "local_capacity":
		return contract.AttemptFailure{Kind: "local_capacity", Message: "edge prebuffer capacity exhausted"}
	}
	return contract.AttemptFailure{
		Kind:                  "gate",
		Reason:                failure.Reason,
		FrameData:             failure.FrameData,
		InferenceText:         failure.InferenceText,
		TerminalBeforeContent: failure.TerminalBeforeContent,
		FramesSeen:            failure.FramesSeen,
		BufferedBytes:         failure.BufferedBytes,
		EchoExcludedBytes:     failure.EchoExcludedBytes,
	}
}

// relay copies the rest of the upstream stream to the client after commit,
// enforcing the idle / body inactivity timeouts and draining upstream for usage
// evidence after a client disconnect.
func (e *execution) relay(
	step *contract.ExecutionStep,
	reader *chunkReader,
	readerDone bool,
	deliver func([]byte),
	clientGone *bool,
	meteringDone *bool,
	metering *capture.MeteringObserver,
) streamOutcome {
	if readerDone {
		return streamOutcome{endedNormally: true}
	}
	idle := time.Duration(step.Timeouts.IdleMs) * time.Millisecond
	bodyTimeout := time.Duration(step.Timeouts.BodyMs) * time.Millisecond
	inactivity := idle
	reason := contract.AbortStreamIdleTimeout
	if inactivity <= 0 || (bodyTimeout > 0 && bodyTimeout < inactivity) {
		inactivity = bodyTimeout
		if idle <= 0 || bodyTimeout < idle {
			reason = contract.AbortStreamResponseTimeout
		}
	}

	clientDone := e.r.Context().Done()
	var drainDeadline <-chan time.Time
	for {
		var timeout <-chan time.Time
		var timer *time.Timer
		if inactivity > 0 {
			timer = time.NewTimer(inactivity)
			timeout = timer.C
		}
		select {
		case next, ok := <-reader.ch:
			if timer != nil {
				timer.Stop()
			}
			if !ok {
				return e.endOfStream(clientGone, nil)
			}
			if len(next.data) > 0 {
				deliver(next.data)
				// After a client disconnect, stop draining once usage evidence is complete.
				if *clientGone && *meteringDone {
					return streamOutcome{clientAborted: true}
				}
			}
			if next.err != nil {
				return e.endOfStream(clientGone, next.err)
			}
		case <-timeout:
			if *clientGone {
				return streamOutcome{clientAborted: true, abortReason: strPtr(contract.AbortClientAborted)}
			}
			return streamOutcome{abortReason: strPtr(reason)}
		case <-clientDone:
			if timer != nil {
				timer.Stop()
			}
			clientDone = nil
			*clientGone = true
			metering.SwitchToDetachedMode()
			if *meteringDone {
				return streamOutcome{clientAborted: true}
			}
			drainDeadline = time.After(time.Duration(step.ClientAbortDrainMs) * time.Millisecond)
		case <-drainDeadline:
			if timer != nil {
				timer.Stop()
			}
			return streamOutcome{clientAborted: true}
		}
	}
}

func (e *execution) endOfStream(clientGone *bool, err error) streamOutcome {
	endedNormally := err == nil || errors.Is(err, io.EOF)
	if *clientGone {
		// Matches the local pump: upstream EOF during the post-disconnect drain still
		// counts as a normal end, the client abort flag carries the disconnect.
		return streamOutcome{endedNormally: endedNormally, clientAborted: true}
	}
	if endedNormally {
		return streamOutcome{endedNormally: true}
	}
	return streamOutcome{abortReason: strPtr(contract.AbortStreamUpstreamAborted)}
}
