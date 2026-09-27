package capture

import (
	"bytes"
	"encoding/json"
	"strings"
)

// CompactCapture builds a small SSE text from a normally-completed
// Anthropic SSE stream, suitable for feeding into the existing TS parsers
// (parseUsageFromResponseText, parseSSEData, extractThinkingSignatureModelFromStream,
// resolveAnthropicStreamActualResponseModel, detectUpstreamErrorFromSseOrJsonText).
//
// Kept, in wire order: the first message_start frame, every message_delta
// frame, the first message_stop frame, every error frame, and up to 4
// content_block_delta frames whose data contains "signature_delta". Each
// kept frame is re-emitted as `event: <name>\ndata: <raw data>\n\n` (LF
// only). message_delta and error frames are always kept even if doing so
// exceeds maxBytes; once the budget is exceeded, no further non-priority
// frames are added and Result() reports truncated=true.
//
// This has no direct TS equivalent; it is new logic designed to this
// package's spec.
type CompactCapture struct {
	maxBytes int

	buf []byte

	eventName *string
	dataLines []string

	out        []byte
	truncated  bool
	overBudget bool
	eventCount int

	messageStartKept   bool
	messageStopKept    bool
	signatureDeltaKept int
}

func NewCompactCapture(maxBytes int) *CompactCapture {
	return &CompactCapture{maxBytes: maxBytes}
}

func (c *CompactCapture) Observe(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	c.buf = append(c.buf, chunk...)
	for {
		idx := bytes.IndexByte(c.buf, '\n')
		if idx < 0 {
			break
		}
		line := c.buf[:idx]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		lineCopy := append([]byte(nil), line...)
		c.buf = c.buf[idx+1:]
		c.processLine(lineCopy)
	}
}

func (c *CompactCapture) processLine(line []byte) {
	if len(line) == 0 {
		c.finalizeFrame()
		return
	}
	if bytes.HasPrefix(line, []byte(":")) {
		return
	}
	if bytes.HasPrefix(line, []byte("event:")) {
		v := strings.TrimSpace(string(line[6:]))
		c.eventName = &v
		return
	}
	if bytes.HasPrefix(line, []byte("data:")) {
		d := line[5:]
		if len(d) > 0 && d[0] == ' ' {
			d = d[1:]
		}
		c.dataLines = append(c.dataLines, string(d))
		return
	}
	// id:/retry:/unrecognized lines are not needed by the downstream parsers
	// this capture feeds; ignore them without breaking frame boundaries.
}

func (c *CompactCapture) finalizeFrame() {
	if len(c.dataLines) == 0 {
		c.eventName = nil
		return
	}

	data := strings.Join(c.dataLines, "\n")
	eventName := c.eventName
	c.eventName = nil
	c.dataLines = nil

	c.eventCount++

	name := ""
	if eventName != nil {
		name = *eventName
	}
	if name == "" {
		name = extractJSONType(data)
	}

	keep, isPriority := c.shouldKeep(name, data)
	if !keep {
		return
	}

	emitted := "event: " + name + "\ndata: " + data + "\n\n"

	if !isPriority {
		if c.overBudget {
			return
		}
		if len(c.out)+len(emitted) > c.maxBytes {
			c.overBudget = true
			c.truncated = true
			return
		}
		c.out = append(c.out, emitted...)
		return
	}

	// message_delta / error: always kept, even if it pushes past the budget.
	if len(c.out)+len(emitted) > c.maxBytes {
		c.truncated = true
	}
	c.out = append(c.out, emitted...)
}

func (c *CompactCapture) shouldKeep(name, data string) (keep bool, isPriority bool) {
	switch name {
	case "message_start":
		if c.messageStartKept {
			return false, false
		}
		c.messageStartKept = true
		return true, false
	case "message_delta":
		return true, true
	case "message_stop":
		if c.messageStopKept {
			return false, false
		}
		c.messageStopKept = true
		return true, false
	case "error":
		return true, true
	case "content_block_delta":
		if strings.Contains(data, "signature_delta") && c.signatureDeltaKept < 4 {
			c.signatureDeltaKept++
			return true, false
		}
		return false, false
	default:
		return false, false
	}
}

func extractJSONType(data string) string {
	var v struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(data), &v); err != nil {
		return ""
	}
	return v.Type
}

// Result finalizes the capture (flushing any pending unterminated frame)
// and reports the compact SSE text, whether it was truncated, and the total
// number of SSE frames observed (kept or not).
func (c *CompactCapture) Result() (text string, truncated bool, eventCount int) {
	if len(c.buf) > 0 {
		line := c.buf
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		c.processLine(line)
		c.buf = nil
	}
	if len(c.dataLines) > 0 {
		c.finalizeFrame()
	}
	return string(c.out), c.truncated, c.eventCount
}
