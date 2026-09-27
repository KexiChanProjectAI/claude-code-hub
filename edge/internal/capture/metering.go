// Package capture ports src/app/v1/_lib/proxy/client-abort-metering.ts
// (loser/client-abort metering) and adds a compact-SSE-capture helper for
// normally-completed streams, stdlib only.
package capture

import (
	"encoding/json"
	"strings"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

const (
	clientAbortMeterMaxRetainedBytes = 64 * 1024
	clientAbortMeterMaxFrameBytes    = 64 * 1024
)

var usageNumberFields = []string{
	"cachedContentTokenCount",
	"cache_creation_1h_input_tokens",
	"cache_creation_5m_input_tokens",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
	"candidatesTokenCount",
	"claude_cache_creation_1_h_tokens",
	"claude_cache_creation_5_m_tokens",
	"completion_tokens",
	"input_tokens",
	"output_tokens",
	"promptTokenCount",
	"prompt_tokens",
	"thoughtsTokenCount",
}

func asRecord(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// compactTokenDetails ports compactTokenDetails.
func compactTokenDetails(value interface{}) *ojson.Value {
	arr, ok := value.([]interface{})
	if !ok {
		return nil
	}
	if len(arr) > 16 {
		arr = arr[:16]
	}
	out := ojson.NewArray()
	for _, entry := range arr {
		em, ok := asRecord(entry)
		if !ok {
			continue
		}
		c := ojson.NewObject()
		if mod, ok := em["modality"].(string); ok {
			c.ObjectSet("modality", ojson.NewString(truncate(mod, 32)))
		}
		if tc, ok := em["tokenCount"].(float64); ok {
			c.ObjectSet("tokenCount", ojson.NewNumberFromFloat(tc))
		}
		if c.ObjectLen() > 0 {
			out.ArrayAppend(c)
		}
	}
	if out.ArrayLen() == 0 {
		return nil
	}
	return out
}

// compactUsage ports compactUsage. Returns (value, true) if it produced a
// non-empty compact object, else (nil, false).
func compactUsage(value interface{}) (*ojson.Value, bool) {
	m, ok := asRecord(value)
	if !ok {
		return nil, false
	}
	compact := ojson.NewObject()
	for _, field := range usageNumberFields {
		if v, ok := m[field].(float64); ok {
			compact.ObjectSet(field, ojson.NewNumberFromFloat(v))
		}
	}

	for _, field := range []string{"input_tokens_details", "prompt_tokens_details"} {
		details, ok := asRecord(m[field])
		if !ok {
			continue
		}
		sub := ojson.NewObject()
		for _, f2 := range []string{"cached_tokens", "cache_write_tokens"} {
			if v, ok := details[f2].(float64); ok {
				sub.ObjectSet(f2, ojson.NewNumberFromFloat(v))
			}
		}
		if sub.ObjectLen() > 0 {
			compact.ObjectSet(field, sub)
		}
	}

	if cc, ok := asRecord(m["cache_creation"]); ok {
		cacheCreation := ojson.NewObject()
		for _, f2 := range []string{"ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"} {
			if v, ok := cc[f2].(float64); ok {
				cacheCreation.ObjectSet(f2, ojson.NewNumberFromFloat(v))
			}
		}
		if cacheCreation.ObjectLen() > 0 {
			compact.ObjectSet("cache_creation", cacheCreation)
		}
	}

	for _, field := range []string{"candidatesTokensDetails", "promptTokensDetails"} {
		if details := compactTokenDetails(m[field]); details != nil {
			compact.ObjectSet(field, details)
		}
	}

	if compact.ObjectLen() == 0 {
		return nil, false
	}
	return compact, true
}

// compactError ports compactError.
func compactError(value interface{}) *ojson.Value {
	if s, ok := value.(string); ok {
		return ojson.NewString(truncate(s, 1024))
	}
	m, ok := asRecord(value)
	if !ok {
		if b, ok := value.(bool); ok && b {
			return ojson.NewBool(true)
		}
		return nil
	}
	compact := ojson.NewObject()
	for _, field := range []string{"code", "message", "type"} {
		if s, ok := m[field].(string); ok {
			compact.ObjectSet(field, ojson.NewString(truncate(s, 1024)))
		}
	}
	if compact.ObjectLen() > 0 {
		return compact
	}
	return ojson.NewBool(true)
}

// compactPayload ports compactPayload.
func compactPayload(value map[string]interface{}, depth int) *ojson.Value {
	compact := ojson.NewObject()
	for _, field := range []string{"id", "model", "prompt_cache_key", "service_tier", "status", "type"} {
		if s, ok := value[field].(string); ok {
			compact.ObjectSet(field, ojson.NewString(truncate(s, 256)))
		}
	}
	if b, ok := value["failed"].(bool); ok && b {
		compact.ObjectSet("failed", ojson.NewBool(true))
	}
	if errVal, exists := value["error"]; exists {
		if ec := compactError(errVal); ec != nil {
			compact.ObjectSet("error", ec)
		}
	}

	for _, field := range []string{"usage", "usageMetadata"} {
		if u, ok := compactUsage(value[field]); ok {
			compact.ObjectSet(field, u)
		}
	}

	if msgM, ok := asRecord(value["message"]); ok {
		message := ojson.NewObject()
		for _, field := range []string{"id", "model"} {
			if s, ok := msgM[field].(string); ok {
				message.ObjectSet(field, ojson.NewString(truncate(s, 256)))
			}
		}
		if u, ok := compactUsage(msgM["usage"]); ok {
			message.ObjectSet("usage", u)
		}
		if message.ObjectLen() > 0 {
			compact.ObjectSet("message", message)
		}
	}

	if deltaM, ok := asRecord(value["delta"]); ok {
		delta := ojson.NewObject()
		if s, ok := deltaM["type"].(string); ok {
			delta.ObjectSet("type", ojson.NewString(truncate(s, 128)))
		}
		if s, ok := deltaM["stop_reason"].(string); ok {
			delta.ObjectSet("stop_reason", ojson.NewString(truncate(s, 128)))
		}
		if s, ok := deltaM["signature"].(string); ok {
			delta.ObjectSet("signature", ojson.NewString(truncate(s, 8192)))
		}
		if u, ok := compactUsage(deltaM["usage"]); ok {
			delta.ObjectSet("usage", u)
		}
		if delta.ObjectLen() > 0 {
			compact.ObjectSet("delta", delta)
		}
	}

	if depth < 4 {
		if respM, ok := asRecord(value["response"]); ok {
			compact.ObjectSet("response", compactPayload(respM, depth+1))
		}
	}

	if choicesArr, ok := value["choices"].([]interface{}); ok {
		entries := choicesArr
		if len(entries) > 16 {
			entries = entries[:16]
		}
		choices := ojson.NewArray()
		for _, ch := range entries {
			o := ojson.NewObject()
			if chM, ok := asRecord(ch); ok {
				if fr, ok := chM["finish_reason"].(string); ok {
					o.ObjectSet("finish_reason", ojson.NewString(truncate(fr, 128)))
				}
			}
			choices.ArrayAppend(o)
		}
		compact.ObjectSet("choices", choices)
	}

	if candidatesArr, ok := value["candidates"].([]interface{}); ok {
		entries := candidatesArr
		if len(entries) > 16 {
			entries = entries[:16]
		}
		candidates := ojson.NewArray()
		for _, cd := range entries {
			o := ojson.NewObject()
			if cdM, ok := asRecord(cd); ok {
				if fr, ok := cdM["finishReason"].(string); ok {
					o.ObjectSet("finishReason", ojson.NewString(truncate(fr, 128)))
				}
			}
			candidates.ArrayAppend(o)
		}
		compact.ObjectSet("candidates", candidates)
	}

	return compact
}

// hasCompactUsage ports hasCompactUsage.
func hasCompactUsage(value map[string]interface{}, depth int) bool {
	if _, ok := compactUsage(value["usage"]); ok {
		return true
	}
	if _, ok := compactUsage(value["usageMetadata"]); ok {
		return true
	}
	if msgM, ok := asRecord(value["message"]); ok {
		if _, ok := compactUsage(msgM["usage"]); ok {
			return true
		}
	}
	if deltaM, ok := asRecord(value["delta"]); ok {
		if _, ok := compactUsage(deltaM["usage"]); ok {
			return true
		}
	}
	if depth < 4 {
		if respM, ok := asRecord(value["response"]); ok {
			return hasCompactUsage(respM, depth+1)
		}
	}
	return false
}

func isProtocolError(value map[string]interface{}) bool {
	if isNonEmptyValue(value["error"]) {
		return true
	}
	if b, ok := value["failed"].(bool); ok && b {
		return true
	}
	if t, ok := value["type"].(string); ok {
		if t == "error" || t == "response.error" || t == "response.failed" {
			return true
		}
	}
	if respM, ok := asRecord(value["response"]); ok {
		if isNonEmptyValue(respM["error"]) {
			return true
		}
	}
	return false
}

func hasOpenAiCompletion(value map[string]interface{}) bool {
	arr, ok := value["choices"].([]interface{})
	if !ok {
		return false
	}
	for _, ch := range arr {
		chM, ok := asRecord(ch)
		if !ok {
			continue
		}
		if fr, ok := chM["finish_reason"].(string); ok && strings.TrimSpace(fr) != "" {
			return true
		}
	}
	return false
}

func hasGeminiCompletion(value map[string]interface{}) bool {
	payload := value
	if respM, ok := asRecord(value["response"]); ok {
		payload = respM
	}
	arr, ok := payload["candidates"].([]interface{})
	if !ok {
		return false
	}
	for _, cd := range arr {
		cdM, ok := asRecord(cd)
		if !ok {
			continue
		}
		if fr, ok := cdM["finishReason"].(string); ok && strings.TrimSpace(fr) != "" {
			return true
		}
	}
	return false
}

// shouldInspectFrame ports shouldInspectFrame.
func shouldInspectFrame(format string, frame parsedFrame) bool {
	if frame.eventName == nil || *frame.eventName == "message" {
		return true
	}
	ev := *frame.eventName
	switch format {
	case "response":
		switch ev {
		case "error", "response.created", "response.in_progress", "response.completed",
			"response.done", "response.incomplete", "response.error", "response.failed":
			return true
		}
		return false
	case "claude":
		switch ev {
		case "error", "message_start", "message_delta", "message_stop":
			return true
		}
		return ev == "content_block_delta" && strings.Contains(frame.data, "signature_delta")
	case "openai", "gemini", "gemini-cli":
		return true
	default:
		return false
	}
}

type protocolFailureState struct {
	Verdict      string
	EventName    *string
	AfterContent bool
	SawMalformed bool
}

// MeteringObserver ports createClientAbortMeteringObserver.
type MeteringObserver struct {
	format string
	framer *boundedEventFramer

	evidenceOrder       []string
	evidence            map[string]string
	evidenceBytes       map[string]int
	evidenceValueCounts map[string]int
	retainedByteTotal   int

	drainComplete        bool
	replayDrainComplete  bool
	openAiCompletionSeen bool
	sawContent           bool
	terminalSeen         bool
	incompleteSeen       bool
	protocolFailure      *protocolFailureState
	finished             bool
}

func NewMeteringObserver(format string, attachedMaxFrameBytes int) *MeteringObserver {
	attached := clientAbortMeterMaxFrameBytes
	if attachedMaxFrameBytes > clientAbortMeterMaxFrameBytes {
		attached = attachedMaxFrameBytes
	}
	m := &MeteringObserver{
		format:              format,
		evidence:            make(map[string]string),
		evidenceBytes:       make(map[string]int),
		evidenceValueCounts: make(map[string]int),
	}
	m.framer = newBoundedEventFramer(attached, m.recordFrame)
	return m
}

func (m *MeteringObserver) setEvidence(slot, value string) {
	previous := m.evidence[slot]
	if previous == value {
		return
	}
	previousBytes := m.evidenceBytes[slot]
	nextBytes := len(value)
	previousCount := 0
	if previous != "" {
		previousCount = m.evidenceValueCounts[previous]
	}
	nextCount := m.evidenceValueCounts[value]
	nextTotal := m.retainedByteTotal
	if previousCount == 1 {
		nextTotal -= previousBytes
	}
	if nextCount == 0 {
		nextTotal += nextBytes
	}
	if nextTotal > clientAbortMeterMaxRetainedBytes {
		return
	}

	if previous != "" {
		if previousCount <= 1 {
			delete(m.evidenceValueCounts, previous)
			m.retainedByteTotal -= previousBytes
		} else {
			m.evidenceValueCounts[previous] = previousCount - 1
		}
	}
	if _, existed := m.evidence[slot]; !existed {
		m.evidenceOrder = append(m.evidenceOrder, slot)
	}
	m.evidence[slot] = value
	m.evidenceBytes[slot] = nextBytes
	m.evidenceValueCounts[value] = nextCount + 1
	if nextCount == 0 {
		m.retainedByteTotal += nextBytes
	}
}

func (m *MeteringObserver) recordProtocolFailure(verdict string, eventName *string) {
	if verdict == "error" {
		m.drainComplete = true
		m.replayDrainComplete = true
	}
	if m.protocolFailure == nil {
		m.protocolFailure = &protocolFailureState{Verdict: verdict, EventName: eventName, AfterContent: m.sawContent}
		return
	}
	if verdict == "error" && m.protocolFailure.Verdict == "malformed" {
		m.protocolFailure = &protocolFailureState{
			Verdict: verdict, EventName: eventName, AfterContent: m.sawContent, SawMalformed: true,
		}
	} else if verdict == "malformed" && m.protocolFailure.Verdict == "error" {
		m.protocolFailure.SawMalformed = true
	}
}

func normalizedFrameText(eventName *string, compactData string) string {
	if eventName != nil {
		return "event: " + *eventName + "\ndata: " + compactData + "\n\n"
	}
	return "data: " + compactData + "\n\n"
}

func (m *MeteringObserver) recordFrame(frame parsedFrame) {
	trimmed := strings.TrimSpace(frame.data)
	if trimmed == "[DONE]" {
		if m.format == "openai" {
			m.drainComplete = true
			m.replayDrainComplete = true
			m.terminalSeen = true
			m.setEvidence("terminal", "data: [DONE]\n\n")
		} else {
			m.recordProtocolFailure("malformed", frame.eventName)
		}
		return
	}

	var parsed interface{}
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		m.recordProtocolFailure("malformed", frame.eventName)
		return
	}
	if parsed == nil {
		m.recordProtocolFailure("malformed", frame.eventName)
		return
	}
	switch parsed.(type) {
	case map[string]interface{}, []interface{}:
		// ok
	default:
		m.recordProtocolFailure("malformed", frame.eventName)
		return
	}

	family := mapClientFormatToProtocolFamily(m.format)
	verdict := classifyStructuredFrame(family, frame.eventName, parsed)
	terminalKind := TerminalNone
	if verdict == VerdictTerminal {
		terminalKind = classifyTerminalKind(family, frame.eventName, parsed)
	}
	if verdict == VerdictContent {
		m.sawContent = true
	}
	if verdict == VerdictError || verdict == VerdictMalformed {
		vs := "error"
		if verdict == VerdictMalformed {
			vs = "malformed"
		}
		m.recordProtocolFailure(vs, frame.eventName)
	}

	parsedMap, isRecord := parsed.(map[string]interface{})
	if !isRecord || !shouldInspectFrame(m.format, frame) {
		return
	}

	isErrorEvent := frame.eventName != nil && *frame.eventName == "error"
	protocolError := verdict == VerdictError || isProtocolError(parsedMap) || isErrorEvent
	typeStr, hasType := parsedMap["type"].(string)
	if !hasType {
		typeStr = ""
	}

	terminal := false
	switch m.format {
	case "response":
		terminal = (typeStr == "response.completed" || typeStr == "response.done") &&
			(frame.eventName == nil || *frame.eventName == "message" || *frame.eventName == typeStr)
	case "claude":
		terminal = typeStr == "message_stop" &&
			(frame.eventName == nil || *frame.eventName == "message" || *frame.eventName == "message_stop")
	case "openai":
		terminal = hasOpenAiCompletion(parsedMap)
	case "gemini", "gemini-cli":
		terminal = hasGeminiCompletion(parsedMap)
	}

	incompleteTerminal := terminalKind == TerminalIncomplete
	hasSignature := false
	if deltaM, ok := asRecord(parsedMap["delta"]); ok {
		if t, _ := deltaM["type"].(string); t == "signature_delta" {
			if s, ok := deltaM["signature"].(string); ok && s != "" {
				hasSignature = true
			}
		}
	}
	hasMetadata := false
	if _, ok := parsedMap["model"].(string); ok {
		hasMetadata = true
	}
	if !hasMetadata {
		if _, ok := parsedMap["prompt_cache_key"].(string); ok {
			hasMetadata = true
		}
	}
	if !hasMetadata {
		if _, ok := parsedMap["service_tier"].(string); ok {
			hasMetadata = true
		}
	}
	if !hasMetadata {
		if msgM, ok := asRecord(parsedMap["message"]); ok {
			if _, ok := msgM["model"].(string); ok {
				hasMetadata = true
			}
		}
	}
	if !hasMetadata {
		if respM, ok := asRecord(parsedMap["response"]); ok {
			if _, ok := respM["model"].(string); ok {
				hasMetadata = true
			} else if _, ok := respM["service_tier"].(string); ok {
				hasMetadata = true
			}
		}
	}
	hasUsage := hasCompactUsage(parsedMap, 0)

	if terminal {
		m.terminalSeen = true
		if m.format == "openai" {
			m.openAiCompletionSeen = true
			if hasUsage {
				m.drainComplete = true
			}
		} else {
			m.drainComplete = true
			m.replayDrainComplete = true
		}
	} else if m.format == "openai" && m.openAiCompletionSeen && hasUsage {
		m.drainComplete = true
	}
	if incompleteTerminal {
		m.incompleteSeen = true
		m.drainComplete = true
		m.replayDrainComplete = true
	}

	if !(protocolError || terminal || incompleteTerminal || hasUsage || hasSignature || hasMetadata) {
		return
	}

	compact := compactPayload(parsedMap, 0)
	compactData := string(compact.Marshal())
	normalized := normalizedFrameText(frame.eventName, compactData)

	if protocolError {
		m.recordProtocolFailure("error", frame.eventName)
		m.setEvidence("error", normalized)
	}
	if terminal || incompleteTerminal {
		m.setEvidence("terminal", normalized)
	}
	if hasUsage {
		isInitialClaudeUsage := m.format == "claude" &&
			(typeStr == "message_start" || (frame.eventName != nil && *frame.eventName == "message_start"))
		slot := "latest-usage"
		if isInitialClaudeUsage {
			slot = "initial-usage"
		}
		m.setEvidence(slot, normalized)
	}
	if hasSignature {
		m.setEvidence("signature", normalized)
	}
	if hasMetadata {
		m.setEvidence("metadata", normalized)
	}
}

// Observe feeds chunk into the framer and reports errorSeen/drainComplete
// as of after processing this chunk.
func (m *MeteringObserver) Observe(chunk []byte) (errorSeen bool, drainComplete bool) {
	if !m.finished {
		m.framer.push(chunk)
	}
	errorSeen = m.protocolFailure != nil && m.protocolFailure.Verdict == "error"
	return errorSeen, m.drainComplete
}

// SwitchToDetachedMode tightens the per-frame byte cap for frames not yet
// fully buffered (in-flight frames keep their attached budget until the
// next frame boundary).
func (m *MeteringObserver) SwitchToDetachedMode() {
	if !m.finished {
		m.framer.setMaxFrameCharacters(clientAbortMeterMaxFrameBytes)
	}
}

// MeteringResult ports ClientAbortMeteringSnapshot.
type MeteringResult struct {
	Text                   string
	SawContent             bool
	TerminalSeen           bool
	IncompleteSeen         bool
	RetainedBytes          int
	SkippedOversizedFrames int
	ProtocolFailure        *contract.ProtocolFailure
}

func (m *MeteringObserver) Finish() MeteringResult {
	if !m.finished {
		m.finished = true
		m.framer.finish()
	}

	seen := make(map[string]bool, len(m.evidenceOrder))
	var parts []string
	for _, slot := range m.evidenceOrder {
		v := m.evidence[slot]
		if seen[v] {
			continue
		}
		seen[v] = true
		parts = append(parts, v)
	}

	var pf *contract.ProtocolFailure
	if m.protocolFailure != nil {
		pf = &contract.ProtocolFailure{
			Verdict:      m.protocolFailure.Verdict,
			EventName:    m.protocolFailure.EventName,
			AfterContent: m.protocolFailure.AfterContent,
			SawMalformed: m.protocolFailure.SawMalformed,
		}
	}

	return MeteringResult{
		Text:                   strings.Join(parts, ""),
		SawContent:             m.sawContent,
		TerminalSeen:           m.terminalSeen,
		IncompleteSeen:         m.incompleteSeen,
		RetainedBytes:          m.retainedByteTotal,
		SkippedOversizedFrames: m.framer.skippedOversizedFrames,
		ProtocolFailure:        pf,
	}
}
