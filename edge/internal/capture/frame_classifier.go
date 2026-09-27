package capture

import "strings"

// ProtocolFamily ports ProtocolFamily from stream-gate/frame-classifier.ts.
type ProtocolFamily string

const (
	FamilyAnthropic       ProtocolFamily = "anthropic"
	FamilyOpenAIChat      ProtocolFamily = "openai-chat"
	FamilyOpenAIResponses ProtocolFamily = "openai-responses"
	FamilyGemini          ProtocolFamily = "gemini"
)

// FrameVerdict ports FrameVerdict.
type FrameVerdict string

const (
	VerdictContent   FrameVerdict = "content"
	VerdictError     FrameVerdict = "error"
	VerdictMalformed FrameVerdict = "malformed"
	VerdictTerminal  FrameVerdict = "terminal"
	VerdictNeutral   FrameVerdict = "neutral"
)

// TerminalKind ports TerminalKind ("" == null).
type TerminalKind string

const (
	TerminalComplete   TerminalKind = "complete"
	TerminalIncomplete TerminalKind = "incomplete"
	TerminalNone       TerminalKind = ""
)

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

// streamSignals ports STREAM_SIGNALS verbatim from frame-classifier.ts.
var streamSignals = map[ProtocolFamily]streamSignal{
	FamilyAnthropic: {
		contentRules: []frameRule{
			{
				eventTypes: []string{"content_block_delta"},
				anyPaths: []string{
					"delta.text", "delta.partial_json", "delta.thinking",
					"delta.signature", "delta.citation",
				},
			},
			{
				eventTypes: []string{"content_block_start"},
				anyPaths: []string{
					"content_block.data", "content_block.content", "content_block.file_id",
					"content_block.fileId", "content_block.url", "content_block.result",
				},
				valueMatches: []valueMatch{
					{
						path: "content_block.type",
						values: []string{
							"redacted_thinking", "web_search_tool_result", "web_fetch_tool_result",
							"code_execution_tool_result", "bash_code_execution_tool_result",
							"text_editor_code_execution_tool_result", "tool_search_tool_result",
							"mcp_tool_result", "container_upload",
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
					"response.output_text.delta", "response.refusal.delta",
					"response.reasoning_text.delta", "response.reasoning_summary_text.delta",
					"response.audio.delta", "response.audio.transcript.delta",
					"response.function_call_arguments.delta", "response.custom_tool_call_input.delta",
					"response.code_interpreter_call_code.delta", "response.mcp_call_arguments.delta",
				},
				anyPaths: []string{"delta"},
			},
			{
				eventTypes: []string{"response.image_generation_call.partial_image"},
				anyPaths:   []string{"partial_image_b64"},
			},
			{
				eventTypes: []string{
					"response.output_text.done", "response.reasoning_text.done",
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
					"item.content.#.text", "item.summary.#.text", "item.arguments", "item.input",
					"item.action", "item.queries", "item.query", "item.code", "item.command",
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
							"IMAGE_PROHIBITED_CONTENT", "NO_IMAGE", "IMAGE_RECITATION", "IMAGE_OTHER",
							"OTHER",
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

func mapClientFormatToProtocolFamily(format string) ProtocolFamily {
	switch format {
	case "response":
		return FamilyOpenAIResponses
	case "claude":
		return FamilyAnthropic
	case "openai":
		return FamilyOpenAIChat
	case "gemini", "gemini-cli":
		return FamilyGemini
	default:
		return FamilyAnthropic
	}
}

// isNonEmptyValue ports isNonEmptyValue (gjson-style non-empty semantics).
func isNonEmptyValue(v interface{}) bool {
	switch val := v.(type) {
	case nil:
		return false
	case bool:
		return val
	case string:
		return val != ""
	case float64:
		return true
	case []interface{}:
		for _, item := range val {
			if isNonEmptyValue(item) {
				return true
			}
		}
		return false
	case map[string]interface{}:
		return len(val) > 0
	default:
		return false
	}
}

// resolvePath ports resolvePath/resolveSegments (gjson-style dotted path with `#` collection).
func resolvePath(node interface{}, path string) interface{} {
	segments := strings.Split(path, ".")
	return resolveSegments(node, segments, 0)
}

func resolveSegments(node interface{}, segments []string, index int) interface{} {
	if index == len(segments) {
		return node
	}
	segment := segments[index]
	if segment == "#" {
		arr, ok := node.([]interface{})
		if !ok {
			return nil
		}
		hasNestedHash := false
		for _, s := range segments[index+1:] {
			if s == "#" {
				hasNestedHash = true
				break
			}
		}
		var collected []interface{}
		for _, item := range arr {
			resolved := resolveSegments(item, segments, index+1)
			if resolved == nil {
				continue
			}
			if sub, ok := resolved.([]interface{}); ok && hasNestedHash {
				collected = append(collected, sub...)
			} else {
				collected = append(collected, resolved)
			}
		}
		return collected
	}
	m, ok := node.(map[string]interface{})
	if !ok {
		return nil
	}
	child, exists := m[segment]
	if !exists {
		return nil
	}
	return resolveSegments(child, segments, index+1)
}

func frameRuleMatches(rule frameRule, eventType string, parsed interface{}) bool {
	if len(rule.eventTypes) > 0 {
		found := false
		for _, e := range rule.eventTypes {
			if e == eventType {
				found = true
				break
			}
		}
		if !found {
			return false
		}
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

func valueMatchHits(match valueMatch, parsed interface{}) bool {
	if match.path == "" || len(match.values) == 0 {
		return false
	}
	resolved := resolvePath(parsed, match.path)
	if resolved == nil {
		return false
	}
	var candidates []interface{}
	if arr, ok := resolved.([]interface{}); ok {
		candidates = arr
	} else {
		candidates = []interface{}{resolved}
	}
	for _, c := range candidates {
		switch cv := c.(type) {
		case string:
			for _, v := range match.values {
				if v == cv {
					return true
				}
			}
		case bool:
			s := "false"
			if cv {
				s = "true"
			}
			for _, v := range match.values {
				if v == s {
					return true
				}
			}
		}
	}
	return false
}

func classifyParsedFrame(family ProtocolFamily, signal streamSignal, eventName *string, parsed interface{}) FrameVerdict {
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if effective == "" {
		if m, ok := parsed.(map[string]interface{}); ok {
			if t, ok := m["type"].(string); ok {
				effective = t
			}
		}
	}

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

// classifyStructuredFrame ports classifyStructuredFrame.
func classifyStructuredFrame(family ProtocolFamily, eventName *string, parsed interface{}) FrameVerdict {
	signal := streamSignals[family]
	outer := classifyParsedFrame(family, signal, eventName, parsed)

	_, isArray := parsed.([]interface{})
	if outer != VerdictNeutral || family != FamilyGemini || isArray {
		return outer
	}

	m, ok := parsed.(map[string]interface{})
	if !ok {
		return outer
	}
	respRaw, exists := m["response"]
	if !exists {
		return outer
	}
	if respM, ok := respRaw.(map[string]interface{}); ok {
		return classifyParsedFrame(family, signal, eventName, respM)
	}
	return outer
}

// classifyStructuredTerminalKind ports classifyStructuredTerminalKind.
func classifyStructuredTerminalKind(family ProtocolFamily, eventName *string, parsed interface{}) TerminalKind {
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	_, isArray := parsed.([]interface{})
	if (effective == "" || effective == "message") && !isArray {
		if m, ok := parsed.(map[string]interface{}); ok {
			if t, ok := m["type"].(string); ok {
				effective = t
			}
		}
	}

	if family == FamilyOpenAIResponses {
		switch effective {
		case "response.incomplete":
			return TerminalIncomplete
		case "response.completed", "response.done":
			return TerminalComplete
		default:
			return TerminalNone
		}
	}

	signal := streamSignals[family]
	if effective != "" {
		for _, e := range signal.terminalEvents {
			if e == effective {
				return TerminalComplete
			}
		}
	}
	for _, rule := range signal.terminalRules {
		if frameRuleMatches(rule, effective, parsed) {
			return TerminalComplete
		}
	}
	return TerminalNone
}

// classifyTerminalKind ports classifyTerminalKind.
func classifyTerminalKind(family ProtocolFamily, eventName *string, parsed interface{}) TerminalKind {
	if parsed != nil {
		if k := classifyStructuredTerminalKind(family, eventName, parsed); k != TerminalNone {
			return k
		}
	}
	if family != FamilyOpenAIResponses {
		return TerminalComplete
	}
	effective := ""
	if eventName != nil {
		effective = strings.TrimSpace(*eventName)
	}
	if (effective == "" || effective == "message") && parsed != nil {
		if _, isArray := parsed.([]interface{}); !isArray {
			if m, ok := parsed.(map[string]interface{}); ok {
				if t, ok := m["type"].(string); ok {
					effective = t
				}
			}
		}
	}
	switch effective {
	case "response.incomplete":
		return TerminalIncomplete
	case "response.completed", "response.done":
		return TerminalComplete
	default:
		return TerminalNone
	}
}

func isResponsesCompactionContent(eventType string, parsed interface{}) bool {
	if _, ok := parsed.([]interface{}); ok {
		return false
	}
	m, ok := parsed.(map[string]interface{})
	if !ok {
		return false
	}
	if eventType == "response.output_item.done" {
		return isNonEmptyCompactionItem(m["item"])
	}
	if eventType != "response.completed" {
		return false
	}
	respRaw, ok := m["response"]
	if !ok {
		return false
	}
	resp, ok := respRaw.(map[string]interface{})
	if !ok {
		return false
	}
	outputRaw, ok := resp["output"]
	if !ok {
		return false
	}
	output, ok := outputRaw.([]interface{})
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

func isNonEmptyCompactionItem(item interface{}) bool {
	m, ok := item.(map[string]interface{})
	if !ok {
		return false
	}
	t, _ := m["type"].(string)
	ec, ecOk := m["encrypted_content"].(string)
	return t == "compaction" && ecOk && ec != ""
}
