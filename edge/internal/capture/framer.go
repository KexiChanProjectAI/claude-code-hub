package capture

import "strings"

// parsedFrame ports ParsedFrame.
type parsedFrame struct {
	eventName *string
	data      string
}

const frameDataLineOverheadCharacters = 16

// boundedEventFramer ports the TS BoundedEventFramer class: incrementally
// frames SSE, data-only SSE, and bounded NDJSON input.
//
// Note: the TS implementation budgets in UTF-16 code units (JS string
// length); this port budgets in bytes of the Go string (which is already
// UTF-8). For the ASCII-dominated protocol frames this code processes the
// two are equivalent; for frames containing many multi-byte characters near
// the budget boundary, byte-length here is a stricter (smaller) count of
// "characters" than TS's UTF-16 length, so this port may drop a frame
// slightly earlier than TS would in that specific edge case.
type boundedEventFramer struct {
	decoder *utf8StreamDecoder

	line                   string
	lineOverflow           bool
	overflowedRawJSONLine  bool
	pendingCR              bool
	eventName              *string
	dataLines              []string
	frameCharacters        int
	droppingFrame          bool
	pendingMaxFrame        *int
	skippedOversizedFrames int

	maxFrameCharacters int
	onFrame            func(parsedFrame)
}

func newBoundedEventFramer(maxFrameCharacters int, onFrame func(parsedFrame)) *boundedEventFramer {
	return &boundedEventFramer{
		decoder:            newUTF8StreamDecoder(),
		maxFrameCharacters: maxFrameCharacters,
		onFrame:            onFrame,
	}
}

func (fr *boundedEventFramer) maxRetainedCharacters() int { return fr.maxFrameCharacters }

func (fr *boundedEventFramer) setMaxFrameCharacters(n int) {
	if n >= fr.maxFrameCharacters {
		return
	}
	hasInFlightFrame := len(fr.line) > 0 || fr.lineOverflow || fr.frameCharacters > 0 ||
		len(fr.dataLines) > 0 || fr.eventName != nil || fr.droppingFrame
	if !hasInFlightFrame {
		fr.maxFrameCharacters = n
		return
	}
	if fr.pendingMaxFrame == nil {
		v := n
		fr.pendingMaxFrame = &v
	} else if n < *fr.pendingMaxFrame {
		*fr.pendingMaxFrame = n
	}
}

func (fr *boundedEventFramer) push(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	fr.consume(fr.decoder.Push(chunk))
}

func (fr *boundedEventFramer) finish() {
	fr.consume(fr.decoder.Finish())
	if len(fr.line) > 0 || fr.lineOverflow {
		fr.consumeLine()
	}
	if fr.droppingFrame {
		fr.completeOversizedFrame()
	} else {
		fr.flushFrame()
	}
}

func (fr *boundedEventFramer) consume(text string) {
	offset := 0
	if fr.pendingCR {
		fr.pendingCR = false
		if strings.HasPrefix(text, "\n") {
			offset = 1
		}
	}

	for offset < len(text) {
		rel := text[offset:]
		nextLf := strings.IndexByte(rel, '\n')
		nextCr := strings.IndexByte(rel, '\r')

		lineEnd := -1
		switch {
		case nextLf == -1 && nextCr == -1:
			lineEnd = -1
		case nextLf == -1:
			lineEnd = offset + nextCr
		case nextCr == -1:
			lineEnd = offset + nextLf
		case nextLf < nextCr:
			lineEnd = offset + nextLf
		default:
			lineEnd = offset + nextCr
		}

		if lineEnd == -1 {
			fr.appendLineSegment(text[offset:])
			return
		}

		fr.appendLineSegment(text[offset:lineEnd])
		fr.consumeLine()
		endedWithCr := text[lineEnd] == '\r'
		offset = lineEnd + 1
		if endedWithCr {
			if offset < len(text) && text[offset] == '\n' {
				offset++
			} else if offset == len(text) {
				fr.pendingCR = true
			}
		}
	}
}

func (fr *boundedEventFramer) appendLineSegment(segment string) {
	if fr.lineOverflow || len(segment) == 0 {
		return
	}
	available := fr.maxFrameCharacters - fr.frameCharacters - len(fr.line)
	if len(segment) <= available {
		fr.line += segment
		return
	}

	cut := available
	if cut < 0 {
		cut = 0
	}
	prefix := fr.line + segment[:cut]
	fr.overflowedRawJSONLine = fr.eventName == nil && len(fr.dataLines) == 0 &&
		strings.HasPrefix(strings.TrimLeft(prefix, " \t\n\r\f\v"), "{")
	fr.line = ""
	fr.lineOverflow = true
	fr.dropCurrentFrame()
}

func (fr *boundedEventFramer) consumeLine() {
	line := fr.line
	overflowed := fr.lineOverflow
	overflowedRawJSONLine := fr.overflowedRawJSONLine
	fr.line = ""
	fr.lineOverflow = false
	fr.overflowedRawJSONLine = false

	if overflowed && overflowedRawJSONLine {
		fr.completeOversizedFrame()
		return
	}

	if len(line) == 0 && !overflowed {
		if fr.droppingFrame {
			fr.completeOversizedFrame()
		} else {
			fr.flushFrame()
		}
		return
	}
	if fr.droppingFrame || overflowed {
		return
	}
	if strings.HasPrefix(line, ":") {
		return
	}
	if strings.HasPrefix(line, "event:") {
		v := strings.TrimSpace(line[6:])
		if len(v) > 256 {
			v = v[:256]
		}
		fr.eventName = &v
		fr.frameCharacters += len(line)
		fr.enforceFrameLimit()
		return
	}
	if strings.HasPrefix(line, "data:") {
		data := trimOneLeadingWhitespace(line[5:])
		fr.dataLines = append(fr.dataLines, data)
		fr.frameCharacters += len(data) + frameDataLineOverheadCharacters
		fr.enforceFrameLimit()
		return
	}

	candidate := strings.TrimSpace(line)
	if fr.eventName == nil && len(fr.dataLines) == 0 && strings.HasPrefix(candidate, "{") {
		if len(candidate) <= fr.maxFrameCharacters {
			fr.onFrame(parsedFrame{eventName: nil, data: candidate})
		} else {
			fr.skippedOversizedFrames++
		}
		fr.applyPendingFrameLimit()
	}
}

func trimOneLeadingWhitespace(s string) string {
	if len(s) == 0 {
		return s
	}
	switch s[0] {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return s[1:]
	}
	return s
}

func (fr *boundedEventFramer) enforceFrameLimit() {
	if fr.frameCharacters <= fr.maxFrameCharacters {
		return
	}
	fr.dropCurrentFrame()
}

func (fr *boundedEventFramer) dropCurrentFrame() {
	if !fr.droppingFrame {
		fr.skippedOversizedFrames++
	}
	fr.droppingFrame = true
	fr.resetFrame()
}

func (fr *boundedEventFramer) completeOversizedFrame() {
	if !fr.droppingFrame {
		return
	}
	fr.droppingFrame = false
	fr.resetFrame()
	fr.applyPendingFrameLimit()
}

func (fr *boundedEventFramer) flushFrame() {
	if fr.droppingFrame || len(fr.dataLines) == 0 {
		fr.resetFrame()
		fr.applyPendingFrameLimit()
		return
	}
	fr.onFrame(parsedFrame{eventName: fr.eventName, data: strings.Join(fr.dataLines, "\n")})
	fr.resetFrame()
	fr.applyPendingFrameLimit()
}

func (fr *boundedEventFramer) resetFrame() {
	fr.eventName = nil
	fr.dataLines = nil
	fr.frameCharacters = 0
}

func (fr *boundedEventFramer) applyPendingFrameLimit() {
	if fr.pendingMaxFrame == nil {
		return
	}
	if *fr.pendingMaxFrame < fr.maxFrameCharacters {
		fr.maxFrameCharacters = *fr.pendingMaxFrame
	}
	fr.pendingMaxFrame = nil
}
