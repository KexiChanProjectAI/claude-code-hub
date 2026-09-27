package gate

import (
	"errors"

	"github.com/ding113/claude-code-hub/edge/internal/sse"
)

// observerMaxBufferBytes mirrors STREAM_PROTOCOL_OBSERVER_MAX_BUFFER_CHARACTERS
// (10 MiB) -- counted in bytes here, see package sse's doc comment.
const observerMaxBufferBytes = 10 * 1024 * 1024

const defaultObserverPrebufferBytes = 10 * 1024 * 1024

// ObservationFailure mirrors StreamProtocolFailure.
type ObservationFailure struct {
	Verdict      string
	EventName    *string
	AfterContent bool
	SawMalformed bool
}

// Observation mirrors StreamProtocolObservation.
type Observation struct {
	SawContent            bool
	SawTerminal           bool
	SawIncomplete         bool
	ObservationIncomplete bool
	Failure               *ObservationFailure
}

// Observer is a Go port of createStreamProtocolObserver: a fail-open,
// non-buffering (bounded) observer over the bytes actually sent to the
// client, used to detect protocol failures/incompleteness after the gate
// has already committed and started streaming.
//
// Deviation: the TS exemption for the observer's own buffer-limit check
// additionally sniffs the pending frame's data head (see package sse's doc
// comment on NewParser); here the exemption is event-name only.
type Observer struct {
	family   Family
	parser   *sse.Parser
	obs      Observation
	finished bool
	disabled bool
}

// NewObserver creates an Observer for family. prebufferByteCap should match
// the gate's configured byte cap (used only to size the echo exemption, via
// IsRequestEchoFrame's event-name check); <= 0 uses a default.
func NewObserver(family Family, prebufferByteCap int) *Observer {
	if prebufferByteCap <= 0 {
		prebufferByteCap = defaultObserverPrebufferBytes
	}
	o := &Observer{family: family}
	o.parser = sse.NewParser(observerMaxBufferBytes, func(pending *string) bool {
		return IsRequestEchoFrame(family, pending, "")
	})
	return o
}

func (o *Observer) record(eventName *string, data string) {
	cls := ClassifyFrame(o.family, eventName, data)
	if cls.Verdict == VerdictContent {
		o.obs.SawContent = true
	}
	switch cls.TerminalKind {
	case "incomplete":
		o.obs.SawIncomplete = true
	case "complete":
		o.obs.SawTerminal = true
	}
	if cls.Verdict != VerdictError && cls.Verdict != VerdictMalformed {
		return
	}
	if o.obs.Failure == nil {
		o.obs.Failure = &ObservationFailure{
			Verdict:      string(cls.Verdict),
			EventName:    eventName,
			AfterContent: o.obs.SawContent,
		}
		return
	}
	if cls.Verdict == VerdictError && o.obs.Failure.Verdict == "malformed" {
		o.obs.Failure = &ObservationFailure{
			Verdict:      "error",
			EventName:    eventName,
			AfterContent: o.obs.SawContent,
			SawMalformed: true,
		}
	} else if cls.Verdict == VerdictMalformed && o.obs.Failure.Verdict == "error" {
		o.obs.Failure.SawMalformed = true
	}
}

func (o *Observer) disableIncomplete() {
	o.disabled = true
	o.obs.ObservationIncomplete = true
}

// Observe feeds one chunk of client-facing bytes into the observer. It
// returns the current failure (nil if none) after processing the chunk.
// Parser resource-limit errors disable further observation (fail-open) but
// never fabricate a malformed/error verdict.
func (o *Observer) Observe(chunk []byte) *ObservationFailure {
	if o.finished || o.disabled || len(chunk) == 0 {
		return o.obs.Failure
	}
	frames, err := o.parser.Push(chunk)
	if err != nil {
		if errors.Is(err, sse.ErrBufferLimit) {
			o.disableIncomplete()
			return o.obs.Failure
		}
		o.disableIncomplete()
		return o.obs.Failure
	}
	for _, f := range frames {
		o.record(f.EventName, f.Data)
	}
	return o.obs.Failure
}

// Finish flushes any trailing unterminated frame and returns the final
// observation. Safe to call multiple times (idempotent after the first
// call).
func (o *Observer) Finish() Observation {
	if !o.finished {
		o.finished = true
		if !o.disabled {
			frames, err := o.parser.Finish()
			if err != nil {
				o.disableIncomplete()
			} else {
				for _, f := range frames {
					o.record(f.EventName, f.Data)
				}
			}
		}
	}
	result := o.obs
	if o.obs.Failure != nil {
		cp := *o.obs.Failure
		result.Failure = &cp
	}
	return result
}
