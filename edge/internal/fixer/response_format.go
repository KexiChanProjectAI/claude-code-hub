package fixer

import (
	"encoding/json"
	"strings"
)

// chatCompletionChunkMarker is the ASCII byte sequence for
// `"chat.completion.chunk"`, used for a cheap byte-level pre-scan before
// decoding/splitting a chunk (ports the CHAT_COMPLETION_CHUNK_MARKER
// pre-scan in response-fixer/index.ts).
var chatCompletionChunkMarker = []byte(`"chat.completion.chunk"`)

func bytesIndexOf(haystack, needle []byte) int {
	if len(needle) == 0 {
		return 0
	}
	limit := len(haystack) - len(needle)
	for i := 0; i <= limit; i++ {
		if haystack[i] != needle[0] {
			continue
		}
		match := true
		for j := 1; j < len(needle); j++ {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func hasMeaningfulValue(value interface{}) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return len(v) > 0
	case []interface{}:
		return len(v) > 0
	case map[string]interface{}:
		return len(v) > 0
	default:
		return true
	}
}

func isInertChatCompletionChoice(choice interface{}) bool {
	m, ok := choice.(map[string]interface{})
	if !ok {
		return false
	}
	if fr, exists := m["finish_reason"]; exists && fr != nil {
		return false
	}
	delta, ok := m["delta"].(map[string]interface{})
	if !ok {
		// A missing/non-object delta cannot carry content: inert.
		return true
	}
	for key, value := range delta {
		if key == "role" {
			continue
		}
		if hasMeaningfulValue(value) {
			return false
		}
	}
	return true
}

func isInertChatCompletionChunkPayload(payload interface{}) bool {
	m, ok := payload.(map[string]interface{})
	if !ok {
		return false
	}
	if obj, _ := m["object"].(string); obj != "chat.completion.chunk" {
		return false
	}
	if hasMeaningfulValue(m["usage"]) {
		return false
	}
	choices, ok := m["choices"].([]interface{})
	if !ok || len(choices) == 0 {
		return false
	}
	for _, ch := range choices {
		if !isInertChatCompletionChoice(ch) {
			return false
		}
	}
	return true
}

func isBlankSseSeparatorLine(line string) bool {
	return line == "" || line == "\r"
}

func isInertChatCompletionDataLine(line string) bool {
	if !strings.HasPrefix(line, "data:") {
		return false
	}
	payloadText := line[len("data:"):]
	if strings.HasPrefix(payloadText, " ") {
		payloadText = payloadText[1:]
	}
	if !strings.HasPrefix(payloadText, "{") {
		return false
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(payloadText), &parsed); err != nil {
		return false
	}
	return isInertChatCompletionChunkPayload(parsed)
}

// filterInertResponsesChatCompletionChunks ports
// ResponseFixer.filterInertResponsesChatCompletionChunks: for the "response"
// (OpenAI Responses API) client format, some OpenAI-compatible upstreams
// wrap their Responses-shaped stream with interleaved, content-free
// `chat.completion.chunk` frames (role-only delta, no usage, no
// finish_reason). Those frames are dropped, along with their trailing blank
// SSE separator line, so the client only sees the (already-handled)
// Responses-shaped events.
func filterInertResponsesChatCompletionChunks(format string, data []byte) FixResult {
	if format != "response" {
		return FixResult{Data: data, Applied: false}
	}
	if bytesIndexOf(data, chatCompletionChunkMarker) < 0 {
		return FixResult{Data: data, Applied: false}
	}

	text := string(data)
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	applied := false
	skipNextBlank := false

	for i, line := range lines {
		hasLineBreak := i < len(lines)-1

		if skipNextBlank && isBlankSseSeparatorLine(line) {
			skipNextBlank = false
			continue
		}
		skipNextBlank = false

		if isInertChatCompletionDataLine(line) {
			applied = true
			skipNextBlank = true
			continue
		}

		out = append(out, line)
		if hasLineBreak {
			out = append(out, "\n")
		}
	}

	if !applied {
		return FixResult{Data: data, Applied: false}
	}

	return FixResult{
		Data:    []byte(strings.Join(out, "")),
		Applied: true,
		Details: "filtered_inert_chat_completion_chunk",
	}
}
