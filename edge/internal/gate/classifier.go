// Package gate is a Go port of the TypeScript stream content gate and
// protocol observer:
//   - src/app/v1/_lib/proxy/stream-gate/frame-classifier.ts
//   - src/app/v1/_lib/proxy/stream-gate/stream-content-gate.ts
//   - src/app/v1/_lib/proxy/stream-gate/stream-protocol-observer.ts
//   - src/app/v1/_lib/proxy/stream-gate/prebuffer-budget.ts (simplified)
//
// See doc comments on individual types for behavioral notes and documented
// deviations from the TypeScript source.
package gate

import (
	"encoding/json"
	"io"
	"strconv"
	"strings"
)

// Family mirrors ProtocolFamily in frame-classifier.ts.
type Family string

const (
	FamilyAnthropic       Family = "anthropic"
	FamilyOpenAIChat      Family = "openai-chat"
	FamilyOpenAIResponses Family = "openai-responses"
	FamilyGemini          Family = "gemini"
)

// Verdict mirrors FrameVerdict in frame-classifier.ts.
type Verdict string

const (
	VerdictContent   Verdict = "content"
	VerdictError     Verdict = "error"
	VerdictMalformed Verdict = "malformed"
	VerdictTerminal  Verdict = "terminal"
	VerdictNeutral   Verdict = "neutral"
)

// Classification is the result of classifying one complete SSE frame.
type Classification struct {
	Verdict Verdict
	// AcceptTerminal is true only for openai-responses frames whose terminal
	// kind is a clean "completed" (status=="completed", no non-empty error)
	// or "incomplete" completion: these are protocol-legitimate terminations
	// the gate should commit/pass through rather than treat as empty_stream.
	AcceptTerminal bool
	// IsEcho reports whether this frame is a provider "request echo" frame
	// (see isRequestEchoFrame in the TS source): such frames' bytes are
	// excluded from the gate's prebuffer byte-cap accounting.
	IsEcho bool
	// TerminalKind is "complete", "incomplete", or "" (no terminal signal in
	// this frame). It can be set even when Verdict is "content" (e.g. a
	// Responses response.completed frame that also carries compaction
	// content), mirroring classifyStructuredTerminalKind being evaluated
	// independently of the verdict in the TS observer.
	TerminalKind string
}

type valueMatch struct {
	path   string
	values []string
}

type frameRule struct {
	eventTypes   []string
	anyPaths     []string
	valueMatches []valueMatch
}

type streamSignal struct {
	contentRules   []frameRule
	errorRules     []frameRule
	terminalRules  []frameRule
	terminalEvents []string
	doneSentinel   string
}

// streamSignals is a direct port of STREAM_SIGNALS in frame-classifier.ts.
var streamSignals = map[Family]streamSignal{
	FamilyAnthropic: {
		contentRules: []frameRule{
			{
				eventTypes: []string{"content_block_delta"},
				anyPaths: []string{
					"delta.text",
					"delta.partial_json",
					"delta.thinking",
					"delta.signature",
					"delta.citation",
				},
			},
			{
				eventTypes: []string{"content_block_start"},
				anyPaths: []string{
					"content_block.data",
					"content_block.content",
					"content_block.file_id",
					"content_block.fileId",
					"content_block.url",
					"content_block.result",
				},
				valueMatches: []valueMatch{
					{
						path: "content_block.type",
						values: []string{
							"redacted_thinking",
							"web_search_tool_result",
							"web_fetch_tool_result",
							"code_execution_tool_result",
							"bash_code_execution_tool_result",
							"text_editor_code_execution_tool_result",
							"tool_search_tool_result",
							"mcp_tool_result",
							"container_upload",
						},
					},
				},
			},
		},
		errorRules: []frameRule{
			{eventTypes: []string{"error", "response.error"}},
			{anyPaths: []string{"error"}},
		},
		terminalEvents: []string{"message_stop"},
	},
	FamilyOpenAIChat: {
		contentRules: []frameRule{
			{
				anyPaths: []string{
					"choices.#.delta.content",
					"choices.#.delta.reasoning_content",
					"choices.#.delta.tool_calls.#.function.arguments",
					"choices.#.delta.function_call.arguments",
					"choices.#.delta.refusal",
					"choices.#.delta.audio.data",
					"choices.#.delta.audio.transcript",
				},
			},
		},
		errorRules: []frameRule{
			{anyPaths: []string{"error"}},
		},
		doneSentinel: "[DONE]",
	},
	FamilyOpenAIResponses: {
		contentRules: []frameRule{
			{
				eventTypes: []string{
					"response.output_text.delta",
					"response.refusal.delta",
					"response.reasoning_text.delta",
					"response.reasoning_summary_text.delta",
					"response.audio.delta",
					"response.audio.transcript.delta",
					"response.function_call_arguments.delta",
					"response.custom_tool_call_input.delta",
					"response.code_interpreter_call_code.delta",
					"response.mcp_call_arguments.delta",
				},
				anyPaths: []string{"delta"},
			},
			{
				eventTypes: []string{"response.image_generation_call.partial_image"},
				anyPaths:   []string{"partial_image_b64"},
			},
			{
				eventTypes: []string{
					"response.output_text.done",
					"response.reasoning_text.done",
					"response.reasoning_summary_text.done",
				},
				anyPaths: []string{"text"},
			},
			{
				eventTypes: []string{"response.audio.transcript.done"},
				anyPaths:   []string{"transcript", "text"},
			},
			{
				eventTypes: []string{"response.refusal.done"},
				anyPaths:   []string{"refusal"},
			},
			{
				eventTypes: []string{"response.function_call_arguments.done", "response.mcp_call_arguments.done"},
				anyPaths:   []string{"arguments"},
			},
			{
				eventTypes: []string{"response.custom_tool_call_input.done"},
				anyPaths:   []string{"input"},
			},
			{
				eventTypes: []string{"response.code_interpreter_call_code.done"},
				anyPaths:   []string{"code"},
			},
			{
				eventTypes: []string{"response.output_item.added", "response.output_item.done"},
				anyPaths: []string{
					"item.content.#.text",
					"item.summary.#.text",
					"item.arguments",
					"item.input",
					"item.action",
					"item.queries",
					"item.query",
					"item.code",
					"item.command",
					"item.operation",
				},
			},
		},
		errorRules: []frameRule{
			{eventTypes: []string{"error", "response.error"}},
			{eventTypes: []string{"response.failed"}},
			{anyPaths: []string{"error", "response.error"}},
		},
		terminalEvents: []string{"response.completed", "response.incomplete", "response.done"},
	},
	FamilyGemini: {
		contentRules: []frameRule{
			{
				anyPaths: []string{
					"candidates.#.content.parts.#.text",
					"candidates.#.content.parts.#.inlineData.data",
					"candidates.#.content.parts.#.fileData.fileUri",
					"candidates.#.content.parts.#.functionCall.name",
					"candidates.#.content.parts.#.functionResponse.name",
					"candidates.#.content.parts.#.executableCode.code",
					"candidates.#.content.parts.#.codeExecutionResult.output",
				},
			},
		},
		errorRules: []frameRule{
			{anyPaths: []string{"error"}},
			{anyPaths: []string{"promptFeedback.blockReason"}},
			{
				valueMatches: []valueMatch{
					{
						path: "candidates.#.finishReason",
						values: []string{
							"SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT",
							"SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "UNEXPECTED_TOOL_CALL",
							"IMAGE_PROHIBITED_CONTENT", "NO_IMAGE", "IMAGE_RECITATION", "IMAGE_OTHER", "OTHER",
						},
					},
				},
			},
		},
		terminalRules: []frameRule{
			{anyPaths: []string{"candidates.#.finishReason"}},
		},
	},
}

// FamilyForProviderType mirrors mapProviderTypeToFamily.
func FamilyForProviderType(providerType string) (Family, bool) {
	switch providerType {
	case "claude", "claude-auth":
		return FamilyAnthropic, true
	case "codex":
		return FamilyOpenAIResponses, true
	case "openai-compatible":
		return FamilyOpenAIChat, true
	case "gemini", "gemini-cli":
		return FamilyGemini, true
	default:
		return "", false
	}
}

var requestEchoEvents = map[Family]map[string]bool{
	FamilyOpenAIResponses: {
		"response.created":     true,
		"response.in_progress": true,
		"response.queued":      true,
	},
}

// IsRequestEchoFrame mirrors isRequestEchoFrame.
//
// Deviation: the TS head-sniff slices UTF-16 code units 0..64; this slices
// bytes 0..64, which may fall mid-codepoint for non-ASCII input. Since the
// sniffed marker (`"type":"..."`) is pure ASCII this does not change results
// in practice.
func IsRequestEchoFrame(family Family, eventName *string, data string) bool {
	events, ok := requestEchoEvents[family]
	if !ok {
		return false
	}
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if effective != "" {
		return events[effective]
	}
	head := data
	if len(head) > 64 {
		head = head[:64]
	}
	for event := range events {
		if strings.Contains(head, `"type":"`+event+`"`) {
			return true
		}
	}
	return false
}

// undefinedMarker distinguishes "path did not resolve" (JS undefined) from a
// resolved JSON null, matching resolvePath's use of `undefined` in TS.
type undefinedType struct{}

var undefinedMarker undefinedType

// ClassifyFrame mirrors classifyFrame + classifyStructuredFrame +
// classifyStructuredTerminalKind + the openai-responses "acceptTerminal"
// computation from frame-probe.ts, evaluated together in one pass since the
// Go API returns them as a single Classification.
//
// Like the TS classifier, this never panics outward: any unexpected failure
// is treated as a neutral classification (fail-open, matching the TS
// try/catch around classifyFrameInner).
func ClassifyFrame(family Family, eventName *string, data string) (result Classification) {
	defer func() {
		if recover() != nil {
			result = Classification{Verdict: VerdictNeutral}
		}
	}()
	return classifyFrameInner(family, eventName, data)
}

func classifyFrameInner(family Family, eventName *string, data string) Classification {
	echo := IsRequestEchoFrame(family, eventName, data)
	signal := streamSignals[family]
	trimmed := strings.TrimSpace(data)

	if trimmed != "" && signal.doneSentinel != "" && trimmed == signal.doneSentinel {
		tk := classifyTerminalKindFallback(family, eventName, nil)
		return Classification{Verdict: VerdictTerminal, IsEcho: echo, TerminalKind: tk}
	}
	if trimmed == "" {
		return Classification{Verdict: VerdictNeutral, IsEcho: echo}
	}
	first := trimmed[0]
	if first != '{' && first != '[' {
		return Classification{Verdict: VerdictMalformed, IsEcho: echo}
	}
	parsed, ok := decodeSingleJSON(trimmed)
	if !ok || parsed == nil {
		return Classification{Verdict: VerdictMalformed, IsEcho: echo}
	}

	verdict := classifyStructuredFrame(family, eventName, parsed)
	// Mirrors the observer's composition: classifyTerminalKind's
	// event-name-only fallback (used when verdict is "terminal" but no
	// structural match applies, e.g. a Gemini/Anthropic terminalEvents hit)
	// combined with -- and overridden by -- the structural
	// classifyStructuredTerminalKind, which can independently detect a
	// terminal signal even on a "content" verdict frame (e.g. a Responses
	// response.completed carrying compaction content).
	terminalKind := ""
	if verdict == VerdictTerminal {
		terminalKind = classifyTerminalKindFallback(family, eventName, parsed)
	}
	if structured := classifyStructuredTerminalKind(family, eventName, parsed); structured != "" {
		terminalKind = structured
	}
	accept := computeAcceptTerminal(family, eventName, parsed)
	return Classification{Verdict: verdict, IsEcho: echo, TerminalKind: terminalKind, AcceptTerminal: accept}
}

// classifyTerminalKindFallback mirrors the exported TS classifyTerminalKind
// (family, eventName, parsed?): when a structural match is available it
// wins; otherwise every family except openai-responses treats any
// verdict=="terminal" frame as a clean completion (there is no separate
// "incomplete" signal outside openai-responses), and openai-responses falls
// back to a bare event-name check.
func classifyTerminalKindFallback(family Family, eventName *string, parsed any) string {
	if parsed != nil {
		if structured := classifyStructuredTerminalKind(family, eventName, parsed); structured != "" {
			return structured
		}
	}
	if family != FamilyOpenAIResponses {
		return "complete"
	}
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if (effective == "" || effective == "message") && parsed != nil {
		if obj, ok := parsed.(map[string]any); ok {
			if t, ok := obj["type"].(string); ok {
				effective = t
			}
		}
	}
	switch effective {
	case "response.incomplete":
		return "incomplete"
	case "response.completed", "response.done":
		return "complete"
	default:
		return ""
	}
}

// decodeSingleJSON parses exactly one JSON value from s, failing if any
// non-whitespace trailing content follows -- matching JSON.parse, which
// throws on trailing garbage.
func decodeSingleJSON(s string) (any, bool) {
	dec := json.NewDecoder(strings.NewReader(s))
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, false
	}
	return v, true
}

// classifyStructuredFrame mirrors classifyStructuredFrame: it classifies the
// parsed frame, and for Gemini, if the outer classification is neutral,
// unwraps a `{response: {...}}` envelope and retries once.
func classifyStructuredFrame(family Family, eventName *string, parsed any) Verdict {
	signal := streamSignals[family]
	outer := classifyParsedFrame(family, signal, eventName, parsed)
	if outer != VerdictNeutral || family != FamilyGemini {
		return outer
	}
	if _, isArray := parsed.([]any); isArray {
		return outer
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return outer
	}
	resp, ok := obj["response"]
	if !ok || resp == nil {
		return outer
	}
	respObj, ok := resp.(map[string]any)
	if !ok {
		return outer
	}
	return classifyParsedFrame(family, signal, eventName, respObj)
}

func effectiveEventType(eventName *string, parsed any) string {
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if effective == "" {
		if obj, ok := parsed.(map[string]any); ok {
			if t, ok := obj["type"].(string); ok {
				effective = t
			}
		}
	}
	return effective
}

func classifyParsedFrame(family Family, signal streamSignal, eventName *string, parsed any) Verdict {
	effective := effectiveEventType(eventName, parsed)

	for _, rule := range signal.errorRules {
		if frameRuleMatches(rule, effective, parsed) {
			return VerdictError
		}
	}
	if family == FamilyOpenAIResponses && isResponsesCompactionContent(effective, parsed) {
		return VerdictContent
	}
	for _, rule := range signal.contentRules {
		if frameRuleMatches(rule, effective, parsed) {
			return VerdictContent
		}
	}
	for _, rule := range signal.terminalRules {
		if frameRuleMatches(rule, effective, parsed) {
			return VerdictTerminal
		}
	}
	if effective != "" {
		for _, e := range signal.terminalEvents {
			if e == effective {
				return VerdictTerminal
			}
		}
	}
	return VerdictNeutral
}

// classifyStructuredTerminalKind mirrors classifyStructuredTerminalKind.
// Returns "complete", "incomplete", or "".
func classifyStructuredTerminalKind(family Family, eventName *string, parsed any) string {
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if (effective == "" || effective == "message") && parsed != nil {
		if _, isArray := parsed.([]any); !isArray {
			if obj, ok := parsed.(map[string]any); ok {
				if t, ok := obj["type"].(string); ok {
					effective = t
				}
			}
		}
	}

	if family == FamilyOpenAIResponses {
		switch effective {
		case "response.incomplete":
			return "incomplete"
		case "response.completed", "response.done":
			return "complete"
		default:
			return ""
		}
	}

	signal := streamSignals[family]
	if effective != "" {
		for _, e := range signal.terminalEvents {
			if e == effective {
				return "complete"
			}
		}
	}
	for _, rule := range signal.terminalRules {
		if frameRuleMatches(rule, effective, parsed) {
			return "complete"
		}
	}
	return ""
}

// computeAcceptTerminal replicates frame-probe.ts's "clean"/"incomplete"
// openai-responses acceptTerminal computation (equivalent to
// isCleanResponsesCompletion || isResponsesIncompleteCompletion evaluated
// against an already-parsed frame).
func computeAcceptTerminal(family Family, eventName *string, parsed any) bool {
	if family != FamilyOpenAIResponses {
		return false
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return false
	}
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	typ, _ := obj["type"].(string)
	resp, hasResp := obj["response"].(map[string]any)
	if !hasResp {
		return false
	}
	status, _ := resp["status"].(string)

	clean := (effective == "" || effective == "response.completed") &&
		typ == "response.completed" &&
		status == "completed" &&
		!isNonEmptyValue(resp["error"])
	incomplete := (effective == "" || effective == "response.incomplete") &&
		typ == "response.incomplete" &&
		status == "incomplete"
	return clean || incomplete
}

// isResponsesCompactionContent mirrors isResponsesCompactionContent.
func isResponsesCompactionContent(eventType string, parsed any) bool {
	if _, isArray := parsed.([]any); isArray {
		return false
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return false
	}
	if eventType == "response.output_item.done" {
		return isNonEmptyCompactionItem(obj["item"])
	}
	if eventType != "response.completed" {
		return false
	}
	resp, ok := obj["response"].(map[string]any)
	if !ok {
		return false
	}
	output, ok := resp["output"].([]any)
	if !ok {
		return false
	}
	for _, item := range output {
		if isNonEmptyCompactionItem(item) {
			return true
		}
	}
	return false
}

func isNonEmptyCompactionItem(item any) bool {
	obj, ok := item.(map[string]any)
	if !ok {
		return false
	}
	if t, _ := obj["type"].(string); t != "compaction" {
		return false
	}
	ec, ok := obj["encrypted_content"].(string)
	return ok && ec != ""
}

// frameRuleMatches mirrors frameRuleMatches: AND semantics across the rule's
// clauses; an empty rule never matches.
func frameRuleMatches(rule frameRule, eventType string, parsed any) bool {
	if len(rule.eventTypes) > 0 && !containsStr(rule.eventTypes, eventType) {
		return false
	}
	if len(rule.anyPaths) > 0 {
		hit := false
		for _, path := range rule.anyPaths {
			if isNonEmptyValue(resolvePath(parsed, path)) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	for _, match := range rule.valueMatches {
		if !valueMatchHits(match, parsed) {
			return false
		}
	}
	return len(rule.eventTypes) > 0 || len(rule.anyPaths) > 0 || len(rule.valueMatches) > 0
}

func valueMatchHits(match valueMatch, parsed any) bool {
	if match.path == "" || len(match.values) == 0 {
		return false
	}
	resolved := resolvePath(parsed, match.path)
	if resolved == undefinedMarker {
		return false
	}
	var candidates []any
	if arr, ok := resolved.([]any); ok {
		candidates = arr
	} else {
		candidates = []any{resolved}
	}
	for _, c := range candidates {
		switch v := c.(type) {
		case string:
			if containsStr(match.values, v) {
				return true
			}
		case bool:
			if containsStr(match.values, jsBoolString(v)) {
				return true
			}
		case float64:
			if containsStr(match.values, jsNumberString(v)) {
				return true
			}
		}
	}
	return false
}

// resolvePath mirrors resolvePath/resolveSegments: gjson-style dotted path
// resolution with `#` mapping/flattening over arrays. Returns undefinedMarker
// when the path does not resolve.
func resolvePath(node any, path string) any {
	return resolveSegments(node, strings.Split(path, "."), 0)
}

func resolveSegments(node any, segments []string, index int) any {
	if index == len(segments) {
		return node
	}
	segment := segments[index]
	if segment == "#" {
		arr, ok := node.([]any)
		if !ok {
			return undefinedMarker
		}
		hasNestedHash := false
		for _, s := range segments[index+1:] {
			if s == "#" {
				hasNestedHash = true
				break
			}
		}
		collected := make([]any, 0, len(arr))
		for _, item := range arr {
			resolved := resolveSegments(item, segments, index+1)
			if resolved == undefinedMarker {
				continue
			}
			if sub, isArr := resolved.([]any); isArr && hasNestedHash {
				collected = append(collected, sub...)
			} else {
				collected = append(collected, resolved)
			}
		}
		return collected
	}
	if node == nil {
		return undefinedMarker
	}
	obj, ok := node.(map[string]any)
	if !ok {
		return undefinedMarker
	}
	child, exists := obj[segment]
	if !exists {
		return undefinedMarker
	}
	return resolveSegments(child, segments, index+1)
}

// isNonEmptyValue mirrors isNonEmptyValue's gjson-style "non-empty" test.
func isNonEmptyValue(value any) bool {
	if value == nil || value == undefinedMarker {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return true
	case json.Number:
		return true
	case []any:
		for _, item := range v {
			if isNonEmptyValue(item) {
				return true
			}
		}
		return false
	case map[string]any:
		return len(v) > 0
	default:
		return false
	}
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func jsBoolString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// jsNumberString approximates ECMA-262's Number::toString for the finite,
// non-huge/non-tiny values realistically found in provider JSON (ids,
// counts). It is not a complete implementation of the spec algorithm, but
// none of the current STREAM_SIGNALS valueMatches rules compare numbers
// (all candidate lists are strings), so this path is exercised only
// defensively.
func jsNumberString(f float64) string {
	if f == 0 {
		return "0"
	}
	abs := f
	if abs < 0 {
		abs = -abs
	}
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go: "1e+21" / "1e-07"; JS: "1e+21" / "1e-7" (no zero-padded exponent).
		if idx := strings.IndexByte(s, 'e'); idx >= 0 {
			mantissa, exp := s[:idx], s[idx+1:]
			sign := "+"
			if len(exp) > 0 && (exp[0] == '+' || exp[0] == '-') {
				sign = string(exp[0])
				exp = exp[1:]
			}
			exp = strings.TrimLeft(exp, "0")
			if exp == "" {
				exp = "0"
			}
			return mantissa + "e" + sign + exp
		}
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
