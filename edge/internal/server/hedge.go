package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/capture"
	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/delegate"
)

// Legacy hedge execution (TS: ProxyForwarder.sendStreamingWithHedge, driven step by
// step by src/app/v1/_lib/edge/hedge-coordinator.ts).
//
// Every attempt runs its pre-commit phase on its own goroutine. The hedge loop turns
// first-byte thresholds and pre-commit failures into /next calls, starts the steps the
// control plane launches, and commits the first attempt that becomes ready. Losers are
// cancelled, or drained for billing evidence when the step asks for it, and reported
// with the winner's completion. After the commit no /next call is made.

var errHedgeLoser = errors.New("hedge loser")

// loserBillingMaxFrameBytes mirrors LOSER_BILLING_MAX_FRAME_BYTES.
const loserBillingMaxFrameBytes = 1 << 20

type hedgeRole int

const (
	roleRacing hedgeRole = iota
	roleWinner
	roleLoserDrain
	roleCancelled
)

type hedgeAttempt struct {
	run *attemptRun

	mu       sync.Mutex
	role     hedgeRole
	finished bool
	prepared *preparedStream
	status   int
	// loserResult receives exactly one result once the attempt is a loser.
	loserResult chan contract.LoserResult
	threshold   *time.Timer
}

func (a *hedgeAttempt) step() *contract.ExecutionStep { return a.run.step }

type hedgeEventKind int

const (
	hedgeReady hedgeEventKind = iota
	hedgeFailed
	hedgeThreshold
	hedgeNextResponse
)

type hedgeEvent struct {
	kind    hedgeEventKind
	attempt *hedgeAttempt
	event   *contract.NextEvent
	// hedgeNextResponse
	failureOrigin bool
	response      *contract.NextResponse
	err           error
}

type hedgeLoop struct {
	e        *execution
	events   chan hedgeEvent
	done     chan struct{}
	attempts []*hedgeAttempt
	racing   map[*hedgeAttempt]bool
	ready    []*hedgeAttempt
	// pendingFailures counts failure /next calls in flight. A ready attempt is not
	// committed while one is pending: the control plane may be settling the request.
	pendingFailures int
}

func (e *execution) runHedge(first *contract.ExecutionStep) {
	loop := &hedgeLoop{
		e:      e,
		events: make(chan hedgeEvent, 64),
		done:   make(chan struct{}),
		racing: map[*hedgeAttempt]bool{},
	}
	defer close(loop.done)
	loop.start(first)

	clientDone := e.r.Context().Done()
	for {
		if loop.pendingFailures == 0 && len(loop.ready) > 0 {
			loop.commit(loop.ready[0])
			return
		}
		if len(loop.racing) == 0 && len(loop.ready) == 0 && loop.pendingFailures == 0 {
			// The control plane answered "wait" with nothing left in flight here.
			e.h.logger.Warn("hedge has no attempt in flight", "requestId", e.requestID)
			delegate.WriteError(e.w, http.StatusBadGateway, "edge hedge state mismatch", "bad_gateway_error")
			return
		}

		select {
		case ev := <-loop.events:
			if loop.handle(ev) {
				return
			}
		case <-clientDone:
			loop.clientAbort()
			return
		}
	}
}

func (l *hedgeLoop) send(ev hedgeEvent) {
	select {
	case l.events <- ev:
	case <-l.done:
	}
}

func (l *hedgeLoop) start(step *contract.ExecutionStep) {
	e := l.e
	attempt := &hedgeAttempt{
		run:         e.newAttemptRun(step, false),
		loserResult: make(chan contract.LoserResult, 1),
	}
	l.attempts = append(l.attempts, attempt)
	l.racing[attempt] = true
	e.h.metrics.attempts.Add("started", 1)

	if step.Hedge != nil && step.Hedge.ThresholdMs > 0 {
		attempt.threshold = time.AfterFunc(time.Duration(step.Hedge.ThresholdMs)*time.Millisecond, func() {
			attempt.mu.Lock()
			racing := attempt.role == roleRacing && !attempt.finished
			attempt.mu.Unlock()
			if racing {
				l.send(hedgeEvent{kind: hedgeThreshold, attempt: attempt})
			}
		})
	}

	go func() {
		run := attempt.run
		if step.DelayMs > 0 && !sleepCtx(run.ctx, time.Duration(step.DelayMs)*time.Millisecond) {
			attempt.finish(nil, attemptResult{event: e.failureEvent(e.classifyAttemptError(run.ctx, context.Cause(run.ctx), false), run.timers, nil)}, l)
			return
		}
		prepared, result := e.prepare(run, true)
		if prepared != nil {
			attempt.mu.Lock()
			attempt.status = prepared.resp.StatusCode
			attempt.mu.Unlock()
		}
		attempt.finish(prepared, result, l)
	}()
}

// finish hands a finished pre-commit phase to the loop (still racing) or resolves
// the attempt as a loser (the winner was committed meanwhile).
func (a *hedgeAttempt) finish(prepared *preparedStream, result attemptResult, l *hedgeLoop) {
	a.mu.Lock()
	a.finished = true
	if a.threshold != nil {
		a.threshold.Stop()
	}
	role := a.role
	if role == roleRacing && prepared != nil {
		a.prepared = prepared
	}
	a.mu.Unlock()

	switch role {
	case roleRacing:
		if prepared != nil {
			l.send(hedgeEvent{kind: hedgeReady, attempt: a})
			return
		}
		a.run.close()
		event := result.event
		if event == nil {
			event = l.e.failureEvent(contract.AttemptFailure{Kind: "invalid_step", Message: "attempt ended without result"}, a.run.timers, nil)
		}
		l.send(hedgeEvent{kind: hedgeFailed, attempt: a, event: event})
	case roleLoserDrain:
		if prepared == nil {
			a.run.close()
			a.loserResult <- a.emptyLoserResult()
			return
		}
		a.loserResult <- l.e.drainLoser(a, prepared)
	default:
		if prepared != nil {
			prepared.close()
		}
		a.run.close()
		a.loserResult <- a.emptyLoserResult()
	}
}

func (a *hedgeAttempt) emptyLoserResult() contract.LoserResult {
	a.mu.Lock()
	status := a.status
	a.mu.Unlock()
	return contract.LoserResult{StepID: a.step().StepID, UpstreamStatus: status, EndedAtMs: time.Now().UnixMilli()}
}

// handle processes one loop event; it returns true when the request is finished.
func (l *hedgeLoop) handle(ev hedgeEvent) bool {
	e := l.e
	switch ev.kind {
	case hedgeReady:
		delete(l.racing, ev.attempt)
		l.ready = append(l.ready, ev.attempt)
	case hedgeFailed:
		delete(l.racing, ev.attempt)
		l.pendingFailures++
		l.callNext(ev.attempt, ev.event, true)
	case hedgeThreshold:
		if !l.racing[ev.attempt] {
			return false
		}
		l.callNext(ev.attempt, &contract.NextEvent{Type: "hedge_threshold"}, false)
	case hedgeNextResponse:
		if ev.failureOrigin {
			l.pendingFailures--
		}
		if ev.err != nil {
			e.h.logger.Warn("hedge next failed", "requestId", e.requestID, "stepId", ev.attempt.step().StepID, "error", ev.err)
			return false
		}
		switch ev.response.Action {
		case "retry", "launch":
			if ev.response.Step != nil && len(l.ready) == 0 {
				l.start(ev.response.Step)
			}
		case "fail":
			l.cancelAll(errHedgeLoser)
			if e.r.Context().Err() == nil {
				writeFailResponse(e.w, ev.response.Response)
			}
			return true
		case "delegate":
			if len(l.racing) == 0 && len(l.ready) == 0 && l.pendingFailures == 0 {
				e.h.delegator.Serve(e.w, e.r, e.raw, "control_plane_delegate")
				return true
			}
		}
	}
	return false
}

func (l *hedgeLoop) callNext(attempt *hedgeAttempt, event *contract.NextEvent, failureOrigin bool) {
	go func() {
		response, err := l.e.next(attempt.step(), event)
		l.send(hedgeEvent{kind: hedgeNextResponse, attempt: attempt, failureOrigin: failureOrigin, response: response, err: err})
	}()
}

// cancelAll cancels every attempt that has not finished and releases ready ones.
func (l *hedgeLoop) cancelAll(cause error) {
	for _, attempt := range l.attempts {
		attempt.mu.Lock()
		prepared := attempt.prepared
		attempt.prepared = nil
		if !attempt.finished {
			attempt.role = roleCancelled
		}
		attempt.mu.Unlock()
		if prepared != nil {
			prepared.close()
		}
		attempt.run.cancel(cause)
	}
}

// clientAbort reports a pre-commit client disconnect once, with the timings of all
// in-flight attempts for first-byte health attribution.
func (l *hedgeLoop) clientAbort() {
	e := l.e
	inflight := make([]*hedgeAttempt, 0, len(l.racing)+len(l.ready))
	for _, attempt := range l.attempts {
		if l.racing[attempt] {
			inflight = append(inflight, attempt)
		}
	}
	inflight = append(inflight, l.ready...)
	l.cancelAll(errClientAborted)
	if len(inflight) == 0 {
		return
	}
	reporter := inflight[0]
	event := e.failureEvent(contract.AttemptFailure{Kind: "client_abort"}, reporter.run.timers, nil)
	for _, peer := range inflight[1:] {
		timing := peer.run.timers.timing()
		dispatched, firstByte := peer.run.timers.snapshot()
		event.Peers = append(event.Peers, contract.PeerTiming{
			StepID:          peer.step().StepID,
			Dispatched:      !dispatched.IsZero(),
			FirstByteSeen:   !firstByte.IsZero(),
			HealthElapsedMs: timing.HealthElapsedMs,
		})
	}
	if _, err := e.next(reporter.step(), event); err != nil {
		e.h.logger.Warn("hedge client abort report failed", "requestId", e.requestID, "error", err)
	}
}

// commit streams the winner and resolves every other attempt as a loser.
func (l *hedgeLoop) commit(winner *hedgeAttempt) {
	e := l.e
	winner.mu.Lock()
	winner.role = roleWinner
	prepared := winner.prepared
	winner.prepared = nil
	winner.mu.Unlock()

	var losers []*hedgeAttempt
	var drainDeadline time.Duration
	for _, attempt := range l.attempts {
		if attempt == winner {
			continue
		}
		attempt.mu.Lock()
		if attempt.finished && attempt.prepared == nil {
			// Failed before the commit: already reported through /next.
			attempt.mu.Unlock()
			continue
		}
		bill := attempt.step().Hedge != nil && attempt.step().Hedge.BillLosers
		if bill {
			attempt.role = roleLoserDrain
			if limit := time.Duration(attempt.step().Hedge.LoserDrainMs) * time.Millisecond; limit > drainDeadline {
				drainDeadline = limit
			}
		} else {
			attempt.role = roleCancelled
		}
		ready := attempt.prepared
		attempt.prepared = nil
		attempt.mu.Unlock()
		losers = append(losers, attempt)

		switch {
		case ready != nil && bill:
			go func(attempt *hedgeAttempt, ready *preparedStream) {
				attempt.loserResult <- e.drainLoser(attempt, ready)
			}(attempt, ready)
		case ready != nil:
			ready.close()
			attempt.run.close()
			attempt.loserResult <- attempt.emptyLoserResult()
		case !bill:
			attempt.run.cancel(errHedgeLoser)
		}
	}
	if drainDeadline > 0 {
		// A loser still in its pre-commit phase gets the same bounded window.
		timer := time.AfterFunc(drainDeadline, func() {
			for _, loser := range losers {
				loser.run.cancel(errHedgeLoser)
			}
		})
		defer timer.Stop()
	}

	collect := func() []contract.LoserResult {
		results := make([]contract.LoserResult, 0, len(losers))
		wait := time.After(drainDeadline + 5*time.Second)
		for _, loser := range losers {
			select {
			case result := <-loser.loserResult:
				results = append(results, result)
			case <-wait:
				results = append(results, loser.emptyLoserResult())
			}
		}
		return results
	}
	e.h.metrics.attempts.Add("hedge_committed", 1)
	e.commitStream(winner.run, prepared, collect)
	winner.run.close()
}

// drainLoser mirrors drainLoserBillingEvidence: read the loser to its end (or until
// the metering evidence is complete / the drain deadline passes) and return the
// bounded metering text for billing.
func (e *execution) drainLoser(attempt *hedgeAttempt, prepared *preparedStream) contract.LoserResult {
	step := attempt.step()
	defer attempt.run.close()
	defer prepared.close()

	observer := capture.NewMeteringObserver(providerFormat(step.Provider.Type), loserBillingMaxFrameBytes)
	stop := false
	observe := func(data []byte) {
		if stop || len(data) == 0 {
			return
		}
		errorSeen, drainComplete := observer.Observe(data)
		stop = errorSeen || drainComplete
	}
	for _, part := range prepared.prefix {
		observe(part)
	}

	endedNaturally := prepared.readerDone
	if !endedNaturally && !stop {
		limit := time.Duration(step.Hedge.LoserDrainMs) * time.Millisecond
		if limit <= 0 {
			limit = time.Second
		}
		deadline := time.NewTimer(limit)
		defer deadline.Stop()
	read:
		for !stop {
			select {
			case next, ok := <-prepared.reader.ch:
				if !ok {
					endedNaturally = true
					break read
				}
				observe(next.data)
				if next.err != nil {
					endedNaturally = errors.Is(next.err, io.EOF)
					break read
				}
			case <-deadline.C:
				break read
			case <-attempt.run.ctx.Done():
				break read
			}
		}
	}

	result := observer.Finish()
	terminalSeen := result.TerminalSeen && (result.ProtocolFailure == nil || result.ProtocolFailure.Verdict != "error")
	return contract.LoserResult{
		StepID:         step.StepID,
		UpstreamStatus: prepared.resp.StatusCode,
		DrainComplete:  endedNaturally || terminalSeen,
		MeteringText:   result.Text,
		EndedAtMs:      time.Now().UnixMilli(),
	}
}
