// Package sse implements an incremental Server-Sent-Events frame parser.
//
// It is a Go port of src/app/v1/_lib/proxy/stream-gate/sse-frames.ts
// (SseFrameParser). It reassembles arbitrarily-split network chunks into
// complete SSE frames (event name + data payload), tolerating:
//   - arbitrary network splits (frame / line / byte boundaries)
//   - LF and CRLF line endings, including a CR landing at the very end of a
//     chunk (the following LF may arrive in the next chunk)
//   - comment lines (leading ':'), multi-line "data:", and ignored
//     "id:"/"retry:"/unknown fields
//   - bare `{`/`[` prefixed JSON lines (no "data:" prefix), one frame per line
//
// Frame boundary semantics match the TypeScript implementation: a blank line
// dispatches the current frame; an event with no data line produces no frame
// but still resets the pending event name.
//
// Deviation from the TypeScript source (documented per task instructions):
//   - The TypeScript buffer-limit exemption inspects both the pending event
//     name and a short prefix of the pending data ("dataHead") to decide
//     whether an oversized-but-recognized frame (e.g. a large request-echo
//     frame) is allowed past the configured limit, subject to its own,
//     separate hard cap. The Go API mandated for this port only receives the
//     pending event name (see NewParser), so the data-head sniffing and the
//     secondary hard cap are not reproduced here: a matching exemption fully
//     exempts the frame from the byte limit (bounded only by whatever the
//     caller does with the resulting Frame.Data downstream, e.g. package
//     gate's own byte-cap accounting).
//   - Byte counts are counted in bytes (UTF-8), not UTF-16 code units as in
//     TypeScript's `string.length`. For content dominated by ASCII framing
//     bytes (which is the common case for SSE field names) this rarely
//     matters; multi-byte payload characters will count as more "bytes" in
//     Go than "characters" in TS.
package sse

import (
	"bytes"
	"errors"
)

// Frame is a single parsed SSE frame.
type Frame struct {
	// EventName is the SSE "event:" field value (trimmed), or nil when the
	// frame had no event field (or was a bare JSON line).
	EventName *string
	// Data is the frame's payload: multi-line "data:" fields are joined with
	// "\n"; a bare JSON line's Data is that line, trimmed.
	Data string
	// Raw holds the exact bytes of the frame as they appeared on the wire,
	// including the terminating blank line when one was present (bare JSON
	// lines and EOF-terminated trailing frames have no blank line, so Raw
	// ends at the line's own terminator, or at the end of input).
	Raw []byte
}

// ErrBufferLimit is returned by Push/Finish when the retained, not-yet
// dispatched buffer exceeds the parser's configured limit.
var ErrBufferLimit = errors.New("sse: buffered data exceeded configured limit")

// Parser incrementally parses SSE frames from a byte stream. It is not safe
// for concurrent use.
type Parser struct {
	maxBufferedBytes int
	exemption        func(pendingEvent *string) bool

	lineBuf       []byte
	skipLeadingLf bool
	currentEvent  *string

	dataBuf       []byte
	dataLineCount int

	rawBuf []byte
}

// NewParser creates a Parser.
//
// maxBufferedBytes bounds the retained (not-yet-dispatched) line/event/data
// buffers; <= 0 means unlimited (matching the TS default of no
// maxBufferedCharacters option).
//
// exemption, when non-nil, is consulted when the limit would otherwise be
// exceeded: it receives the pending event name (as it would be attributed to
// the in-flight frame) and, if it returns true, the limit check is skipped
// for that update. See the package doc for how this differs from the
// TypeScript implementation's exemption, which also inspects data content.
func NewParser(maxBufferedBytes int, exemption func(pendingEvent *string) bool) *Parser {
	return &Parser{maxBufferedBytes: maxBufferedBytes, exemption: exemption}
}

// Push feeds a network chunk into the parser, returning any frames completed
// by it (possibly none).
func (p *Parser) Push(chunk []byte) ([]Frame, error) {
	var frames []Frame
	if err := p.consume(chunk, &frames); err != nil {
		return nil, err
	}
	return frames, nil
}

// Finish signals end of input: it flushes a trailing unterminated line (if
// any) as one final line, and dispatches a trailing frame if one is pending.
func (p *Parser) Finish() ([]Frame, error) {
	var frames []Frame
	p.skipLeadingLf = false
	if len(p.lineBuf) > 0 {
		if err := p.handleLine(&frames); err != nil {
			return nil, err
		}
	}
	if err := p.flush(&frames); err != nil {
		return nil, err
	}
	return frames, nil
}

func (p *Parser) consume(data []byte, out *[]Frame) error {
	start := 0
	if p.skipLeadingLf {
		p.skipLeadingLf = false
		if len(data) == 0 {
			return nil
		}
		if data[0] == '\n' {
			p.rawBuf = append(p.rawBuf, data[0])
			start = 1
		}
	}

	for i := start; i < len(data); i++ {
		c := data[i]
		if c != '\n' && c != '\r' {
			continue
		}
		p.lineBuf = append(p.lineBuf, data[start:i]...)
		p.rawBuf = append(p.rawBuf, data[start:i+1]...)

		if err := p.assertBufferLimitForCompletedLine(); err != nil {
			return err
		}
		if err := p.handleLine(out); err != nil {
			return err
		}

		if c == '\r' {
			if i+1 < len(data) && data[i+1] == '\n' {
				p.rawBuf = append(p.rawBuf, data[i+1])
				i++
			} else if i == len(data)-1 {
				p.skipLeadingLf = true
			}
		}
		start = i + 1
	}

	p.lineBuf = append(p.lineBuf, data[start:]...)
	p.rawBuf = append(p.rawBuf, data[start:]...)
	return p.assertBufferLimitDefault()
}

// takeLine consumes and clears the current line buffer.
func (p *Parser) takeLine() []byte {
	line := p.lineBuf
	p.lineBuf = nil
	return line
}

func (p *Parser) handleLine(out *[]Frame) error {
	line := p.takeLine()
	if len(line) == 0 {
		return p.flush(out)
	}
	if line[0] == ':' {
		return nil // SSE comment
	}
	if hasPrefix(line, "event:") {
		v := trimSpace(string(line[6:]))
		p.currentEvent = &v
		return p.assertBufferLimitDefault()
	}
	if hasPrefix(line, "data:") {
		d := stripOneLeadingSpace(line[5:])
		if p.dataLineCount > 0 {
			p.dataBuf = append(p.dataBuf, '\n')
		}
		p.dataBuf = append(p.dataBuf, d...)
		p.dataLineCount++
		return p.assertBufferLimitDefault()
	}

	candidate := bytes.TrimSpace(line)
	if p.currentEvent == nil && p.dataLineCount == 0 && len(candidate) > 0 &&
		(candidate[0] == '{' || candidate[0] == '[') {
		raw := p.takeRaw()
		*out = append(*out, Frame{EventName: nil, Data: string(candidate), Raw: raw})
		return nil
	}
	// id: / retry: / unknown fields: ignored.
	return nil
}

func (p *Parser) flush(out *[]Frame) error {
	event := p.currentEvent
	p.currentEvent = nil
	if p.dataLineCount == 0 {
		return nil
	}
	data := string(p.dataBuf)
	p.dataBuf = nil
	p.dataLineCount = 0
	raw := p.takeRaw()
	*out = append(*out, Frame{EventName: event, Data: data, Raw: raw})
	return nil
}

func (p *Parser) takeRaw() []byte {
	raw := p.rawBuf
	p.rawBuf = nil
	return raw
}

func (p *Parser) resetRetainedState() {
	p.lineBuf = nil
	p.currentEvent = nil
	p.dataBuf = nil
	p.dataLineCount = 0
	p.skipLeadingLf = false
	p.rawBuf = nil
}

// assertBufferLimitDefault mirrors SseFrameParser#assertBufferLimit() called
// with no arguments: it charges the full current line buffer (there is no
// completed-line prefix to discount) plus the pending event and data
// buffers.
func (p *Parser) assertBufferLimitDefault() error {
	return p.assertBufferLimit(len(p.lineBuf), false, p.currentEvent)
}

// assertBufferLimitForCompletedLine mirrors the TS call site that runs right
// after a full line has been appended to the line buffer but before it is
// classified/consumed: SSE field syntax ("data:"/"event:" plus at most one
// separating space) is excluded from the count, and if the completed line is
// itself an "event:" field it will replace (not add to) the currently
// tracked event name.
func (p *Parser) assertBufferLimitForCompletedLine() error {
	line := p.lineBuf
	ignored := 0
	replaces := false
	candidate := p.currentEvent
	switch {
	case hasPrefix(line, "data:"):
		ignored = 5
		if len(line) > 5 && line[5] == ' ' {
			ignored = 6
		}
	case hasPrefix(line, "event:"):
		ignored = 6
		if len(line) > 6 && line[6] == ' ' {
			ignored = 7
		}
		replaces = true
		v := trimSpace(string(line[6:]))
		candidate = &v
	}
	return p.assertBufferLimit(ignored, replaces, candidate)
}

func (p *Parser) assertBufferLimit(ignoredLineBytes int, replacesCurrentEvent bool, candidateEvent *string) error {
	if p.maxBufferedBytes <= 0 {
		return nil
	}
	lineLen := len(p.lineBuf) - ignoredLineBytes
	if lineLen < 0 {
		lineLen = 0
	}
	eventLen := 0
	if !replacesCurrentEvent && p.currentEvent != nil {
		eventLen = len(*p.currentEvent)
	}
	buffered := lineLen + eventLen + len(p.dataBuf)
	if buffered <= p.maxBufferedBytes {
		return nil
	}
	if p.exemption != nil && p.exemption(candidateEvent) {
		return nil
	}
	p.resetRetainedState()
	return ErrBufferLimit
}

func hasPrefix(b []byte, prefix string) bool {
	return len(b) >= len(prefix) && string(b[:len(prefix)]) == prefix
}

func trimSpace(s string) string {
	return string(bytes.TrimSpace([]byte(s)))
}

// stripOneLeadingSpace removes at most one leading space/whitespace byte,
// mirroring TS `line.slice(5).replace(/^\s/, "")` (JS \s strips a single
// leading whitespace character, not just a literal space).
func stripOneLeadingSpace(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	switch b[0] {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return b[1:]
	}
	return b
}

// ParseBody parses a complete SSE body in one shot (equivalent of TS
// parseSseBody).
func ParseBody(body []byte) ([]Frame, error) {
	p := NewParser(0, nil)
	frames, err := p.Push(body)
	if err != nil {
		return nil, err
	}
	tail, err := p.Finish()
	if err != nil {
		return nil, err
	}
	return append(frames, tail...), nil
}
