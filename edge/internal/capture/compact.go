package capture

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// CompactCapture builds a small SSE (or raw-JSON) text from a normally
// completed upstream response, suitable for feeding into the existing TS
// settlement parsers (parseUsageFromResponseText, parseSSEData,
// extractThinkingSignatureModelFromStream, resolveAnthropicStreamActualResponseModel,
// detectUpstreamErrorFromSseOrJsonText, extractActualResponseModelForProvider,
// hasStreamCompletionMarker / hasTerminalStreamUsageEvidence,
// SessionManager.extractCodexPromptCacheKey).
//
// Two rule sets are implemented, selected by NewCompactCaptureForFormat:
//
//   - "claude" (the original, and NewCompactCapture's default): kept, in wire
//     order, the first message_start frame, every message_delta frame, the
//     first message_stop frame, every error frame, and up to 4
//     content_block_delta frames whose data contains "signature_delta". Each
//     kept frame is re-emitted as `event: <name>\ndata: <raw data>\n\n` (LF
//     only), synthesizing the event name from the JSON `type` field when the
//     source frame had no `event:` line. message_delta and error frames are
//     always kept even if doing so exceeds maxBytes; once the budget is
//     exceeded, no further non-priority frames are added and Result()
//     reports truncated=true. This has no direct TS equivalent; it is
//     logic designed to this package's spec.
//
//   - "response" / "openai": kept, in original wire order: the first frame
//     observed (carries model / prompt_cache_key in realistic streams), the
//     first few (up to compactUsageFrameCap) frames carrying a usage object
//     (data.usage or data.response.usage) plus always the LAST such frame,
//     the last frame carrying a non-empty service_tier (top-level or
//     data.response.service_tier), every terminal/completion frame
//     (response.completed / response.done / response.incomplete /
//     response.failed for "response"; any chunk with a non-empty
//     choices[].finish_reason, and the literal `data: [DONE]` frame, for
//     "openai"), and every error-relevant frame (non-empty `error`,
//     `failed`, type error/response.error/response.failed, a nested
//     response.error or response.status "failed", or a small JSON body
//     whose `message` field matches /error/i). Unlike the claude variant,
//     every kept frame is "priority" (always kept even over maxBytes,
//     tracked via truncated); nothing else is retained since no downstream
//     consumer needs response/openai body content for settlement. Frames
//     are re-emitted verbatim: `event: <name>\ndata: <raw data>\n\n` when the
//     source frame had an `event:` line, or `data: <raw data>\n\n` when it
//     did not (parseSSEData treats both the same, defaulting to event
//     "message", so this preserves that behavior instead of synthesizing a
//     name the way the claude variant does). If the stream never contained a
//     single parseable SSE/data-only frame (e.g. a forced-stream codex
//     response that is a bare JSON body), Result() falls back to the raw
//     text prefix (up to maxBytes) so settlement still sees a non-empty
//     body -- this also guarantees the "empty body" case of
//     detectUpstreamErrorFromSseOrJsonText agrees between full and compact,
//     since the first frame is always retained whenever at least one frame
//     was observed.
//
// This has no direct TS equivalent; it is new logic designed to this
// package's spec.
type CompactCapture struct {
	format   string
	maxBytes int

	buf []byte

	eventName *string
	dataLines []string

	out        []byte
	truncated  bool
	overBudget bool
	eventCount int

	// claude-only state
	messageStartKept   bool
	messageStopKept    bool
	signatureDeltaKept int

	// response/openai-only state
	curSeq          int
	kept            map[int]compactFrameEntry
	usageKeptCount  int
	lastUsageEntry  *compactFrameEntry
	lastTierEntry   *compactFrameEntry
	sawAnyFrame     bool
	rawFallbackBuf  []byte
	rawFallbackFull bool
}

// compactUsageFrameCap bounds how many *early* usage-bearing frames are kept
// unconditionally for response/openai formats (the last usage-bearing frame
// is always kept too, regardless of this cap).
const compactUsageFrameCap = 4

type compactFrameEntry struct {
	seq       int
	eventName *string
	data      string
}

func NewCompactCapture(maxBytes int) *CompactCapture {
	return NewCompactCaptureForFormat("claude", maxBytes)
}

// NewCompactCaptureForFormat constructs a CompactCapture for client format
// "claude" | "response" | "openai". Unknown formats fall back to "claude".
func NewCompactCaptureForFormat(format string, maxBytes int) *CompactCapture {
	c := &CompactCapture{format: format, maxBytes: maxBytes}
	if format == "response" || format == "openai" {
		c.kept = make(map[int]compactFrameEntry)
	}
	return c
}

func (c *CompactCapture) isClaude() bool {
	return c.format != "response" && c.format != "openai"
}

func (c *CompactCapture) Observe(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	if !c.isClaude() && !c.rawFallbackFull {
		room := c.maxBytes - len(c.rawFallbackBuf)
		if room > 0 {
			take := chunk
			if len(take) > room {
				take = take[:room]
			}
			c.rawFallbackBuf = append(c.rawFallbackBuf, take...)
		}
		if len(c.rawFallbackBuf) >= c.maxBytes {
			c.rawFallbackFull = true
		}
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

	if c.isClaude() {
		c.finalizeFrameClaude(eventName, data)
		return
	}
	c.finalizeFrameOther(eventName, data)
}

// --- claude ------------------------------------------------------------

func (c *CompactCapture) finalizeFrameClaude(eventName *string, data string) {
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

// --- response / openai ---------------------------------------------------

var compactErrorMessageKeywordRe = regexp.MustCompile(`(?i)error`)

func (c *CompactCapture) finalizeFrameOther(eventName *string, data string) {
	seq := c.curSeq
	c.curSeq++
	c.sawAnyFrame = true

	entry := compactFrameEntry{seq: seq, eventName: eventName, data: data}
	trimmed := strings.TrimSpace(data)

	isDoneSentinel := c.format == "openai" && trimmed == "[DONE]"

	var m map[string]interface{}
	isJSON := false
	if !isDoneSentinel {
		if err := json.Unmarshal([]byte(data), &m); err == nil && m != nil {
			isJSON = true
		}
	}

	isFirst := seq == 0
	hasUsage := isJSON && compactHasUsage(m)
	hasTier := isJSON && compactServiceTier(m) != ""
	isTerminal := isDoneSentinel
	isError := false
	if isJSON {
		switch c.format {
		case "response":
			isTerminal = isTerminal || compactIsResponsesTerminal(m)
			isError = compactIsResponsesError(eventName, m)
		case "openai":
			isTerminal = isTerminal || compactIsOpenAIChatTerminal(m)
			isError = compactIsOpenAIChatError(m)
		}
	}

	if isFirst || isTerminal || isError {
		c.addKept(entry)
	}
	if hasUsage {
		if c.usageKeptCount < compactUsageFrameCap {
			c.addKept(entry)
			c.usageKeptCount++
		}
		c.lastUsageEntry = &entry
	}
	if hasTier {
		c.lastTierEntry = &entry
	}
}

func (c *CompactCapture) addKept(entry compactFrameEntry) {
	c.kept[entry.seq] = entry
}

func compactAsRecord(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func compactIsNonEmptyValue(value interface{}) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(v) != ""
	case float64:
		return v != 0
	case bool:
		return v
	case []interface{}:
		return len(v) > 0
	case map[string]interface{}:
		return len(v) > 0
	default:
		return true
	}
}

func compactHasUsage(m map[string]interface{}) bool {
	if u, ok := m["usage"]; ok {
		if _, isObj := compactAsRecord(u); isObj {
			return true
		}
	}
	if resp, ok := compactAsRecord(m["response"]); ok {
		if u, ok := resp["usage"]; ok {
			if _, isObj := compactAsRecord(u); isObj {
				return true
			}
		}
	}
	return false
}

func compactServiceTier(m map[string]interface{}) string {
	if s, ok := m["service_tier"].(string); ok && strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s)
	}
	if resp, ok := compactAsRecord(m["response"]); ok {
		if s, ok := resp["service_tier"].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// compactIsResponsesTerminal ports the "response" branch of
// inspectStreamCompletion (response-handler.ts) plus response.failed, which
// is a terminal marker for compaction purposes even though it is also an
// error.
func compactIsResponsesTerminal(m map[string]interface{}) bool {
	t, _ := m["type"].(string)
	switch t {
	case "response.completed", "response.done", "response.incomplete", "response.failed":
		return true
	}
	return false
}

// compactIsResponsesError ports isDiscoveryProtocolErrorPayload
// (discovery-validity.ts) plus the small-message-keyword branch of
// detectUpstreamErrorFromSseOrJsonText (upstream-error-detection.ts).
func compactIsResponsesError(eventName *string, m map[string]interface{}) bool {
	if compactIsNonEmptyValue(m["error"]) {
		return true
	}
	if b, ok := m["failed"].(bool); ok && b {
		return true
	}
	if t, ok := m["type"].(string); ok {
		if t == "error" || t == "response.error" || t == "response.failed" {
			return true
		}
	}
	if resp, ok := compactAsRecord(m["response"]); ok {
		if compactIsNonEmptyValue(resp["error"]) {
			return true
		}
		if st, ok := resp["status"].(string); ok && st == "failed" {
			return true
		}
	}
	if eventName != nil && *eventName == "error" {
		return true
	}
	if msg, ok := m["message"].(string); ok && compactErrorMessageKeywordRe.MatchString(msg) {
		return true
	}
	return false
}

// compactIsOpenAIChatTerminal ports hasOpenAIChatCompletionMarker
// (response-handler.ts): any choices[] entry with a non-empty finish_reason.
func compactIsOpenAIChatTerminal(m map[string]interface{}) bool {
	choices, ok := m["choices"].([]interface{})
	if !ok {
		return false
	}
	for _, ch := range choices {
		chM, ok := compactAsRecord(ch)
		if !ok {
			continue
		}
		if fr, ok := chM["finish_reason"].(string); ok && strings.TrimSpace(fr) != "" {
			return true
		}
	}
	return false
}

// compactIsOpenAIChatError ports the JSON-object branch of
// detectUpstreamErrorFromSseOrJsonText for a Chat Completions chunk.
func compactIsOpenAIChatError(m map[string]interface{}) bool {
	if compactIsNonEmptyValue(m["error"]) {
		return true
	}
	if msg, ok := m["message"].(string); ok && compactErrorMessageKeywordRe.MatchString(msg) {
		return true
	}
	return false
}

func renderCompactFrame(entry compactFrameEntry) string {
	if entry.eventName != nil {
		return "event: " + *entry.eventName + "\ndata: " + entry.data + "\n\n"
	}
	return "data: " + entry.data + "\n\n"
}

func (c *CompactCapture) resultOther() (string, bool, int) {
	if c.lastUsageEntry != nil {
		c.addKept(*c.lastUsageEntry)
	}
	if c.lastTierEntry != nil {
		c.addKept(*c.lastTierEntry)
	}

	if len(c.kept) == 0 {
		if !c.sawAnyFrame {
			// No parseable SSE/data-only frame was ever observed (e.g. a
			// forced-stream codex response that is a bare JSON body):
			// fall back to the raw text prefix so settlement still sees a
			// non-empty body.
			return string(c.rawFallbackBuf), c.rawFallbackFull, c.eventCount
		}
		return "", false, c.eventCount
	}

	seqs := make([]int, 0, len(c.kept))
	for s := range c.kept {
		seqs = append(seqs, s)
	}
	sort.Ints(seqs)

	var out []byte
	for _, s := range seqs {
		out = append(out, renderCompactFrame(c.kept[s])...)
	}

	return string(out), len(out) > c.maxBytes, c.eventCount
}

// Result finalizes the capture (flushing any pending unterminated frame)
// and reports the compact text, whether it was truncated, and the total
// number of frames observed (kept or not).
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

	if !c.isClaude() {
		return c.resultOther()
	}

	return string(c.out), c.truncated, c.eventCount
}
