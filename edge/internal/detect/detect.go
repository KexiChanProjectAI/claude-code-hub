// Package detect ports the non-streaming subset of
// src/lib/utils/upstream-error-detection.ts detectUpstreamErrorFromSseOrJsonText
// (as used from src/app/v1/_lib/proxy/forwarder.ts's non-stream 2xx branch,
// called with maxJsonCharsForMessageCheck: 0, i.e. the weak "message contains
// 'error'" signal is never triggered) plus the forwarder's non-stream empty
// body / missing-content checks used when Content-Length is absent.
package detect

import (
	"strings"

	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

const htmlDocSniffMaxChars = 1024

// SuspectNonStream reports whether body looks like an upstream "fake 200":
// an HTML error document, an empty body, or a JSON object carrying a
// non-empty `error` field or an OpenAI Responses `response.failed` /
// `status: "failed"` payload. This is a superset of the TS "strong signal"
// codes (FAKE_200_EMPTY_BODY, FAKE_200_HTML_BODY, FAKE_200_JSON_ERROR_NON_EMPTY,
// FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY, FAKE_200_OPENAI_RESPONSE_FAILED); the
// control plane re-verifies with the full TS logic before acting on it.
func SuspectNonStream(body []byte, contentType string) bool {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return true
	}
	trimmed = stripBOM(trimmed)

	if isLikelyHTMLDocument(trimmed) {
		return true
	}

	if strings.HasPrefix(trimmed, "{") {
		v, err := ojson.Parse([]byte(trimmed), ojson.DefaultMaxDepth)
		if err != nil || !v.IsObject() {
			return false
		}
		return detectFromJSONObject(v)
	}

	return false
}

// EmptyReason ports the forwarder's non-stream empty-response checks used
// when Content-Length is absent or invalid:
//   - empty/whitespace body -> "empty_body"
//   - Claude `{"type":"message","content":[]}` -> "missing_content"
//   - OpenAI `{"choices":[]}` (choices present but empty/non-array) -> "missing_content"
//
// Returns "" when none of the checks trigger (including malformed JSON,
// which the TS code silently tolerates by skipping the content check).
func EmptyReason(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return "empty_body"
	}

	v, err := ojson.Parse([]byte(trimmed), ojson.DefaultMaxDepth)
	if err != nil || !v.IsObject() {
		return ""
	}

	if typ, ok := v.ObjectGet("type"); ok && typ.IsString() && typ.String() == "message" {
		content, ok := v.ObjectGet("content")
		if !ok || !content.IsArray() || content.ArrayLen() == 0 {
			return "missing_content"
		}
	}

	if choices, ok := v.ObjectGet("choices"); ok {
		if !choices.IsArray() || choices.ArrayLen() == 0 {
			return "missing_content"
		}
	}

	return ""
}

var bomRune = string(rune(0xFEFF))

func stripBOM(s string) string {
	if strings.HasPrefix(s, bomRune) {
		return strings.TrimLeft(s[len(bomRune):], " \t\n\r\v\f")
	}
	return s
}

func isLikelyHTMLDocument(trimmed string) bool {
	if !strings.HasPrefix(trimmed, "<") {
		return false
	}
	head := trimmed
	if len(head) > htmlDocSniffMaxChars {
		head = head[:htmlDocSniffMaxChars]
	}
	lower := strings.ToLower(head)
	if strings.HasPrefix(lower, "<!doctype html") {
		rest := lower[len("<!doctype html"):]
		if rest == "" || rest[0] == ' ' || rest[0] == '\t' || rest[0] == '\n' || rest[0] == '\r' || rest[0] == '\f' || rest[0] == '\v' || rest[0] == '>' {
			return true
		}
	}
	if strings.HasPrefix(lower, "<html") {
		rest := lower[len("<html"):]
		if rest == "" || rest[0] == ' ' || rest[0] == '\t' || rest[0] == '\n' || rest[0] == '\r' || rest[0] == '\f' || rest[0] == '\v' || rest[0] == '>' {
			return true
		}
	}
	return false
}

func detectFromJSONObject(obj *ojson.Value) bool {
	if detectOpenAIResponsesFailed(obj) {
		return true
	}

	errVal, ok := obj.ObjectGet("error")
	if ok && hasNonEmptyValue(errVal) {
		return true
	}

	// maxJsonCharsForMessageCheck is always 0 for the non-stream detector
	// use in forwarder.ts, so the weak `message` keyword signal never fires.
	return false
}

func detectOpenAIResponsesFailed(obj *ojson.Value) bool {
	eventType := ""
	if t, ok := obj.ObjectGet("type"); ok && t.IsString() {
		eventType = strings.TrimSpace(t.String())
	}
	response := obj
	if r, ok := obj.ObjectGet("response"); ok && r.IsObject() {
		response = r
	}
	responseStatus := ""
	if s, ok := response.ObjectGet("status"); ok && s.IsString() {
		responseStatus = strings.TrimSpace(s.String())
	}
	responseObject := ""
	if o, ok := response.ObjectGet("object"); ok && o.IsString() {
		responseObject = strings.TrimSpace(o.String())
	}
	responseID := ""
	if id, ok := response.ObjectGet("id"); ok && id.IsString() {
		responseID = strings.TrimSpace(id.String())
	}

	looksLikeOpenAIResponse := strings.HasPrefix(eventType, "response.") ||
		responseObject == "response" || strings.HasPrefix(responseID, "resp_")
	isFailedResponse := eventType == "response.failed" || responseStatus == "failed"

	return looksLikeOpenAIResponse && isFailedResponse
}

func hasNonEmptyValue(v *ojson.Value) bool {
	if v == nil || v.IsNull() {
		return false
	}
	switch {
	case v.IsString():
		return strings.TrimSpace(v.String()) != ""
	case v.IsNumber():
		f, err := v.Float64()
		return err == nil && f != 0
	case v.IsBool():
		return v.Bool()
	case v.IsArray():
		return v.ArrayLen() > 0
	case v.IsObject():
		return v.ObjectLen() > 0
	default:
		return true
	}
}
