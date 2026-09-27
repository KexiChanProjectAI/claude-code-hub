package gate

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/sse"
)

// readChunkBytes is the size of the buffer used for each upstream Read call.
const readChunkBytes = 32 * 1024

// Options configures Run. See the package-level doc comment and Run's doc
// comment for the algorithm this ports (runStreamContentGate in
// stream-content-gate.ts).
type Options struct {
	Family              Family
	EventCap            int
	ByteCap             int
	IdleTimeout         time.Duration
	CaptureCommitMarker bool
	Budget              *Budget
	OnFirstByte         func()
}

// Failure mirrors the fields of StreamPrecommitError's construction detail
// plus its `reason`.
type Failure struct {
	Reason                string
	FrameData             string
	InferenceText         string
	TerminalBeforeContent bool
	FramesSeen            int
	BufferedBytes         int
	EchoExcludedBytes     int
}

// CommitMarker mirrors StreamGateCommitMarker.
type CommitMarker struct {
	FrameIndex        int
	ChunkIndex        int
	EventName         *string
	BufferedBytes     int
	EchoExcludedBytes int
}

// Result mirrors StreamGateResult, extended with Go-specific fields (ReadErr,
// ReaderDone renamed nothing -- see field docs).
type Result struct {
	Committed    bool
	Prefix       [][]byte
	ReaderDone   bool
	Failure      *Failure
	CommitMarker *CommitMarker
	FramesSeen   int
	ReadErr      error
}

type readOutcome struct {
	n   int
	err error
}

// Run executes the stream content gate's precommit loop over r: it buffers
// upstream bytes, classifying each completed SSE frame, until either a
// content frame commits the prefix, an error/malformed/disallowed-terminal
// frame fails the attempt, or a resource limit (event cap, byte cap, idle
// timeout, budget exhaustion) is hit.
//
// ctx cancellation (e.g. a first-byte timer elsewhere, or the caller
// aborting) stops the loop and is reported via Result.ReadErr; Run does not
// close or cancel r itself -- the caller remains responsible for r's
// lifecycle (closing the body / cancelling whatever produces r is what
// unblocks a Read call that is in flight when Run returns early).
//
// Goroutine note: each upstream Read is issued from its own goroutine so it
// can race against the idle timer and ctx.Done(). In the normal path (a read
// completes before any timeout/cancellation) that goroutine has already
// exited by the time Run reads its result. In the early-return paths (idle
// timeout, ctx cancellation), the in-flight Read's goroutine is left running
// until the underlying Read call itself returns (e.g. because the caller
// closed/cancelled whatever r wraps); its result is then discarded by the
// GC'd, unreferenced channel. Run does not leak a goroutine that runs
// forever on its own -- it always leaks at most until r.Read unblocks.
func Run(ctx context.Context, r io.Reader, opts Options) Result {
	var (
		framesSeen        int
		chunkIndex        int
		bufferedBytes     int
		echoExcludedBytes int
		prefix            [][]byte
		firstByteSeen     bool
	)

	var lease *Lease
	if opts.Budget != nil {
		reservation := int64(opts.ByteCap)
		if reservation <= 0 {
			reservation = readChunkBytes
		}
		l, err := opts.Budget.Acquire(ctx, reservation)
		if err != nil {
			if errors.Is(err, ErrLocalCapacity) {
				return Result{Failure: &Failure{Reason: "local_capacity"}}
			}
			return Result{ReadErr: err}
		}
		lease = l
	}
	releaseLease := func() {
		if lease != nil {
			lease.Release()
			lease = nil
		}
	}

	exemption := func(pending *string) bool {
		return IsRequestEchoFrame(opts.Family, pending, "")
	}
	parserLimit := opts.ByteCap * 2
	if parserLimit <= 0 {
		parserLimit = 0 // unlimited
	}
	parser := sse.NewParser(parserLimit, exemption)

	fail := func(reason string, frameData string, terminalBeforeContent bool) Result {
		releaseLease()
		f := &Failure{
			Reason:                reason,
			TerminalBeforeContent: terminalBeforeContent,
			FramesSeen:            framesSeen,
			BufferedBytes:         bufferedBytes,
			EchoExcludedBytes:     echoExcludedBytes,
		}
		if frameData != "" {
			f.FrameData = truncateBytes(frameData, 2000)
			if reason == "gate_error" {
				f.InferenceText = truncateBytes(strings.TrimLeft(frameData, " \t\n\r\v\f"), 64*1024)
			}
		}
		return Result{Committed: false, Failure: f, FramesSeen: framesSeen}
	}

	commit := func(eventName *string, readerDone bool) Result {
		var marker *CommitMarker
		if opts.CaptureCommitMarker {
			marker = &CommitMarker{
				FrameIndex:        framesSeen,
				ChunkIndex:        chunkIndex,
				EventName:         eventName,
				BufferedBytes:     bufferedBytes,
				EchoExcludedBytes: echoExcludedBytes,
			}
		}
		releaseLease()
		return Result{
			Committed:    true,
			Prefix:       prefix,
			ReaderDone:   readerDone,
			FramesSeen:   framesSeen,
			CommitMarker: marker,
		}
	}

	exceedsByteCap := func() bool {
		if opts.ByteCap <= 0 {
			return false
		}
		excluded := echoExcludedBytes
		if excluded > opts.ByteCap {
			excluded = opts.ByteCap
		}
		return bufferedBytes-excluded > opts.ByteCap
	}

	// processFrames classifies newly parsed frames, returning a non-nil
	// *Result when the loop must stop (commit or failure).
	processFrames := func(frames []sse.Frame) *Result {
		for _, fr := range frames {
			framesSeen++
			cls := ClassifyFrame(opts.Family, fr.EventName, fr.Data)
			switch cls.Verdict {
			case VerdictContent:
				if exceedsByteCap() {
					res := fail("prebuffer_overflow", "", false)
					return &res
				}
				res := commit(fr.EventName, false)
				return &res
			case VerdictError:
				res := fail("gate_error", fr.Data, false)
				return &res
			case VerdictMalformed:
				res := fail("decode_error", fr.Data, false)
				return &res
			case VerdictTerminal:
				if opts.Family == FamilyOpenAIResponses && cls.AcceptTerminal {
					if exceedsByteCap() {
						res := fail("prebuffer_overflow", "", false)
						return &res
					}
					res := commit(fr.EventName, false)
					return &res
				}
				res := fail("empty_stream", fr.Data, true)
				return &res
			default: // neutral
				if cls.IsEcho {
					echoExcludedBytes += len(fr.Data)
				}
				if opts.EventCap > 0 && framesSeen > opts.EventCap {
					res := fail("prebuffer_overflow", "", false)
					return &res
				}
			}
		}
		if exceedsByteCap() {
			res := fail("prebuffer_overflow", "", false)
			return &res
		}
		return nil
	}

	buf := make([]byte, readChunkBytes)
	reqCh := make(chan readOutcome, 1)

	for {
		go func() {
			n, err := r.Read(buf)
			reqCh <- readOutcome{n, err}
		}()

		var out readOutcome
		if opts.IdleTimeout > 0 {
			timer := time.NewTimer(opts.IdleTimeout)
			select {
			case out = <-reqCh:
				timer.Stop()
			case <-timer.C:
				return fail("idle_timeout", "", false)
			case <-ctx.Done():
				timer.Stop()
				releaseLease()
				return Result{ReadErr: ctx.Err(), FramesSeen: framesSeen}
			}
		} else {
			select {
			case out = <-reqCh:
			case <-ctx.Done():
				releaseLease()
				return Result{ReadErr: ctx.Err(), FramesSeen: framesSeen}
			}
		}

		if out.n > 0 {
			chunk := make([]byte, out.n)
			copy(chunk, buf[:out.n])

			if !firstByteSeen {
				firstByteSeen = true
				if opts.OnFirstByte != nil {
					opts.OnFirstByte()
				}
			}
			chunkIndex++

			if opts.ByteCap > 0 && len(chunk) > opts.ByteCap*2-bufferedBytes {
				return fail("prebuffer_overflow", "", false)
			}
			prefix = append(prefix, chunk)
			bufferedBytes += len(chunk)

			frames, perr := parser.Push(chunk)
			if perr != nil {
				if errors.Is(perr, sse.ErrBufferLimit) {
					return fail("prebuffer_overflow", "", false)
				}
				releaseLease()
				return Result{ReadErr: perr, FramesSeen: framesSeen}
			}
			if res := processFrames(frames); res != nil {
				return *res
			}
		}

		if out.err != nil {
			if out.err == io.EOF {
				frames, ferr := parser.Finish()
				if ferr != nil {
					if errors.Is(ferr, sse.ErrBufferLimit) {
						return fail("prebuffer_overflow", "", false)
					}
					releaseLease()
					return Result{ReadErr: ferr, FramesSeen: framesSeen}
				}
				sawTerminal, result := processTrailingFrames(frames, opts, &framesSeen, commit, fail)
				if result != nil {
					return *result
				}
				return fail("empty_stream", "", sawTerminal)
			}
			releaseLease()
			return Result{ReadErr: out.err, FramesSeen: framesSeen}
		}
		// out.n == 0 && out.err == nil: spurious empty read; loop again.
	}
}

// processTrailingFrames mirrors the EOF-flush branch of runStreamContentGate:
// it walks the frames flushed by parser.Finish(), stopping at the first
// commit/failure decision, and separately tracks whether a (non-accepted)
// terminal frame was seen for the eventual empty_stream's
// terminalBeforeContent flag.
func processTrailingFrames(
	frames []sse.Frame,
	opts Options,
	framesSeen *int,
	commit func(eventName *string, readerDone bool) Result,
	fail func(reason string, frameData string, terminalBeforeContent bool) Result,
) (sawTerminal bool, result *Result) {
	for _, fr := range frames {
		*framesSeen++
		cls := ClassifyFrame(opts.Family, fr.EventName, fr.Data)
		switch cls.Verdict {
		case VerdictContent:
			res := commit(fr.EventName, true)
			return sawTerminal, &res
		case VerdictError:
			res := fail("gate_error", fr.Data, false)
			return sawTerminal, &res
		case VerdictMalformed:
			res := fail("decode_error", fr.Data, false)
			return sawTerminal, &res
		case VerdictTerminal:
			if opts.Family == FamilyOpenAIResponses && cls.AcceptTerminal {
				res := commit(fr.EventName, true)
				return sawTerminal, &res
			}
			sawTerminal = true
		default:
			if opts.EventCap > 0 && *framesSeen > opts.EventCap {
				res := fail("prebuffer_overflow", "", false)
				return sawTerminal, &res
			}
		}
	}
	return sawTerminal, nil
}

// truncateBytes returns s truncated to at most n bytes. Deviation: TS caps
// these previews in UTF-16 code units; this caps in bytes (see package sse's
// doc comment for the same tradeoff).
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
