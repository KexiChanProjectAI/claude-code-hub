// Package digest builds contract.RequestDigest from a parsed request body,
// mirroring src/app/v1/_lib/edge/digest.ts buildRequestDigest (which in turn
// calls into response-input-rectifier.ts#rectifyResponseInput,
// ProxySession.getMessages/isProbeRequest/isWarmupRequest,
// SessionManager.calculateMessagesHash, remote-compaction.ts#isRemoteCompactionV2Request,
// codex/session-completer.ts#extractInitialMessageTextHash and computeFingerprintChain).
package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"unicode"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

// Input carries everything Build needs to compute a RequestDigest.
type Input struct {
	EdgeID         string
	EdgeRequestID  string
	ReceivedAtMs   int64
	Method         string
	Path           string
	Headers        []contract.HeaderPair
	ClientIP       *string
	Body           *ojson.Value // parsed body; may be nil if BodyParseError is set
	BodyBytes      int
	BodyParseError *string
}

// Build computes the RequestDigest for in, matching buildRequestDigest in
// src/app/v1/_lib/edge/digest.ts field for field.
func Build(in Input) contract.RequestDigest {
	originalBody := in.Body
	if originalBody == nil || !originalBody.IsObject() {
		// Mirrors the TS caller always passing a parsed object; when parsing
		// failed upstream we degrade to an empty object like TS would.
		originalBody = ojson.NewObject()
	}

	format := resolveEdgeClientFormat(in.Path)

	// Response Input Rectifier runs before the guard pipeline: content-derived
	// digest fields are computed on a normalized clone of the body, matching
	// digest.ts's `const body = structuredClone(params.body)` + conditional rectify.
	normalized := originalBody.Clone()
	var responseInputRectify *contract.ResponseInputRectify
	if format == contract.FormatResponse {
		result := rectifyResponseInput(normalized)
		responseInputRectify = &contract.ResponseInputRectify{
			Action:       result.action,
			OriginalType: result.originalType,
		}
	}

	pn := pathname(in.Path)
	messages := getMessagesLike(normalized)

	var codexInitialTextHash *string
	if inputVal, ok := normalized.ObjectGet("input"); ok && inputVal.IsArray() {
		codexInitialTextHash = extractInitialMessageTextHash(normalized)
	}

	return contract.RequestDigest{
		SchemaVersion:        contract.SchemaVersion,
		EdgeID:               in.EdgeID,
		EdgeRequestID:        in.EdgeRequestID,
		ReceivedAtMs:         in.ReceivedAtMs,
		Method:               in.Method,
		Path:                 in.Path,
		Format:               format,
		Headers:              in.Headers,
		ClientIP:             in.ClientIP,
		BodyBytes:            in.BodyBytes,
		BodyParseError:       in.BodyParseError,
		TopLevel:             buildTopLevel(normalized),
		MessagesCount:        arrayLenPtr(normalized, "messages"),
		InputCount:           arrayLenPtr(normalized, "input"),
		ResponseInputRectify: responseInputRectify,
		// isRemoteCompactionV2Request is called with the ORIGINAL, un-normalized
		// body in digest.ts (params.body, not the clone), so use originalBody here.
		IsRemoteCompactionV2: isRemoteCompactionV2Request(pn, originalBody),
		CodexInitialTextHash: codexInitialTextHash,
		SystemKind:           resolveSystemKind(normalized),
		HasPrivateParams:     hasPrivateKeys(normalized),
		IsProbe:              isProbeRequest(messages),
		IsWarmup:             isWarmupRequest(normalized, in.Path),
		MessagesHash:         calculateMessagesHash(messages),
		Fingerprint:          ComputeFingerprintChain(normalized, format, MaxAffinityWindow),
	}
}

// resolveEdgeClientFormat ports resolveEdgeClientFormat in digest.ts: response/openai
// are kept, everything else (including unsupported paths) resolves to "claude".
func resolveEdgeClientFormat(rawPath string) string {
	p := normalizeEndpointPath(pathname(rawPath))
	switch {
	case p == "/v1/responses" || strings.HasPrefix(p, "/v1/responses/"):
		return contract.FormatResponse
	case p == "/v1/chat/completions" || strings.HasPrefix(p, "/v1/chat/completions/"):
		return contract.FormatOpenAI
	default:
		return contract.FormatClaude
	}
}

func buildTopLevel(body *ojson.Value) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage)
	for _, key := range contract.TopLevelKeys {
		if v, ok := body.ObjectGet(key); ok {
			out[key] = json.RawMessage(v.Marshal())
		}
	}
	return out
}

func arrayLenPtr(body *ojson.Value, key string) *int {
	if v, ok := body.ObjectGet(key); ok && v.IsArray() {
		n := v.ArrayLen()
		return &n
	}
	return nil
}

func resolveSystemKind(body *ojson.Value) string {
	v, ok := body.ObjectGet("system")
	if !ok {
		return "absent"
	}
	switch {
	case v.IsString():
		return "string"
	case v.IsArray():
		return "array"
	default:
		return "other"
	}
}

// hasPrivateKeys ports hasPrivateKeys(value) from digest.ts: recursively
// scans arrays and objects for any object key starting with "_".
func hasPrivateKeys(v *ojson.Value) bool {
	if v == nil {
		return false
	}
	switch {
	case v.IsArray():
		for _, item := range v.ArrayItems() {
			if hasPrivateKeys(item) {
				return true
			}
		}
		return false
	case v.IsObject():
		for _, k := range v.ObjectKeys() {
			if strings.HasPrefix(k, "_") {
				return true
			}
			child, _ := v.ObjectGet(k)
			if hasPrivateKeys(child) {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// getMessagesLike ports ProxySession.getMessages (session.ts ~L1100): messages,
// else input, else contents, else request.contents, else absent. Returns the
// raw value (which may not be an array); callers that need array semantics
// check IsArray() themselves, matching how isProbeRequest/calculateMessagesHash
// treat a present-but-non-array value as "not usable" rather than falling
// through to the next candidate.
func getMessagesLike(body *ojson.Value) *ojson.Value {
	if v, ok := body.ObjectGet("messages"); ok {
		return v
	}
	if v, ok := body.ObjectGet("input"); ok {
		return v
	}
	if v, ok := body.ObjectGet("contents"); ok {
		return v
	}
	if reqVal, ok := body.ObjectGet("request"); ok && reqVal.IsObject() {
		if v, ok := reqVal.ObjectGet("contents"); ok {
			return v
		}
	}
	return nil
}

// isProbeRequest ports ProxySession.isProbeRequest (session.ts ~L1656), applied
// to the result of getMessages() (not hardcoded to the "messages" field, so it
// also covers Response API "input" arrays).
func isProbeRequest(messages *ojson.Value) bool {
	if !messages.IsArray() || messages.ArrayLen() != 1 {
		return false
	}
	first := messages.ArrayGet(0)
	if !first.IsObject() {
		return false
	}
	content, ok := first.ObjectGet("content")
	if !ok || !content.IsString() {
		return false
	}
	trimmed := strings.ToLower(jsTrim(content.String()))
	return trimmed == "foo" || trimmed == "count"
}

// isWarmupRequest ports ProxySession.isWarmupRequest (session.ts ~L1688). Unlike
// isProbeRequest, the TS source reads `message.messages` directly rather than
// through getMessages(); this only matters when combined with the endpoint
// check ("/v1/messages"), which restricts the format to "claude" in practice.
func isWarmupRequest(body *ojson.Value, rawPath string) bool {
	if normalizeEndpointPath(pathname(rawPath)) != "/v1/messages" {
		return false
	}
	messages, ok := body.ObjectGet("messages")
	if !ok || !messages.IsArray() || messages.ArrayLen() != 1 {
		return false
	}
	first := messages.ArrayGet(0)
	if !first.IsObject() {
		return false
	}
	role, ok := first.ObjectGet("role")
	if !ok || !role.IsString() || role.String() != "user" {
		return false
	}
	content, ok := first.ObjectGet("content")
	if !ok || !content.IsArray() || content.ArrayLen() != 1 {
		return false
	}
	block := content.ArrayGet(0)
	if !block.IsObject() {
		return false
	}
	typ, ok := block.ObjectGet("type")
	if !ok || !typ.IsString() || typ.String() != "text" {
		return false
	}
	text := ""
	if tv, ok := block.ObjectGet("text"); ok && tv.IsString() {
		text = jsTrim(tv.String())
	}
	if strings.ToLower(text) != "warmup" {
		return false
	}
	cc, ok := block.ObjectGet("cache_control")
	if !ok || !cc.IsObject() {
		return false
	}
	ccType, ok := cc.ObjectGet("type")
	return ok && ccType.IsString() && ccType.String() == "ephemeral"
}

// pathname mirrors ProxySession.getEndpoint(): new URL(path, "http://edge.local").pathname.
func pathname(rawPath string) string {
	u, err := url.Parse(rawPath)
	if err != nil {
		return ""
	}
	if u.Path == "" {
		return "/"
	}
	return u.Path
}

// normalizeEndpointPath ports normalizeEndpointPath (endpoint-paths.ts): strip
// query, strip one trailing slash, lowercase.
func normalizeEndpointPath(p string) string {
	if idx := strings.IndexByte(p, '?'); idx >= 0 {
		p = p[:idx]
	}
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		p = strings.TrimSuffix(p, "/")
	}
	return strings.ToLower(p)
}

// jsTrim strips the same set of characters JS String.prototype.trim strips:
// Unicode whitespace plus the line terminators (LS/PS) and BOM.
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSWhitespace)
}

func isJSWhitespace(r rune) bool {
	switch r {
	case rune(0xFEFF), rune(0x2028), rune(0x2029):
		return true
	}
	return unicode.IsSpace(r)
}

// calculateMessagesHash ports SessionManager.calculateMessagesHash
// (session-manager.ts ~L827-893), applied to the result of getMessages()
// (probe.getMessages() in digest.ts, not hardcoded to the "messages" field).
func calculateMessagesHash(messages *ojson.Value) *string {
	if !messages.IsArray() || messages.ArrayLen() == 0 {
		return nil
	}

	count := messages.ArrayLen()
	if count > 3 {
		count = 3
	}

	contents := make([]string, 0, count)
	for i := 0; i < count; i++ {
		msg := messages.ArrayGet(i)
		if msg == nil || !msg.IsObject() {
			continue
		}
		content, ok := msg.ObjectGet("content")
		if !ok {
			continue
		}
		if content.IsString() {
			contents = append(contents, content.String())
		} else if content.IsArray() {
			var sb strings.Builder
			for _, item := range content.ArrayItems() {
				if !item.IsObject() {
					continue
				}
				typ, ok := item.ObjectGet("type")
				if !ok || !typ.IsString() || typ.String() != "text" {
					continue
				}
				if textVal, ok := item.ObjectGet("text"); ok {
					sb.WriteString(jsStringOrEmpty(textVal))
				}
			}
			contents = append(contents, sb.String())
		}
	}

	if len(contents) == 0 {
		return nil
	}

	combined := strings.Join(contents, "|")
	sum := sha256.Sum256([]byte(combined))
	hash := hex.EncodeToString(sum[:])[:16]
	return &hash
}

// jsStringOrEmpty mirrors how the TS `.map((item) => item.text)` would
// coerce a non-string `text` field when joined into a string (Array.prototype.join
// stringifies each element; undefined/null become "").
func jsStringOrEmpty(v *ojson.Value) string {
	if v == nil || v.IsNull() {
		return ""
	}
	if v.IsString() {
		return v.String()
	}
	// Non-string text fields are not expected in valid payloads; TS would
	// coerce via string concatenation. We fall back to the compact JSON form,
	// which only matters for malformed inputs outside the ported contract.
	return string(v.Marshal())
}

// ---- response-input-rectifier.ts#rectifyResponseInput ----

type responseInputRectifyResult struct {
	action       string
	originalType string
}

// rectifyResponseInput ports rectifyResponseInput (response-input-rectifier.ts).
// It mutates message.input in place, matching the TS "在 message 对象上原地修改" contract.
func rectifyResponseInput(message *ojson.Value) responseInputRectifyResult {
	input, hasInput := message.ObjectGet("input")

	// Case 1: array -- passthrough.
	if hasInput && input.IsArray() {
		return responseInputRectifyResult{action: "passthrough", originalType: "array"}
	}

	// Case 2: string.
	if hasInput && input.IsString() {
		if input.String() == "" {
			message.ObjectSet("input", ojson.NewArray())
			return responseInputRectifyResult{action: "empty_string_to_empty_array", originalType: "string"}
		}

		wrapped := ojson.NewArray()
		item := ojson.NewObject()
		item.ObjectSet("role", ojson.NewString("user"))
		contentArr := ojson.NewArray()
		contentBlock := ojson.NewObject()
		contentBlock.ObjectSet("type", ojson.NewString("input_text"))
		contentBlock.ObjectSet("text", ojson.NewString(input.String()))
		contentArr.ArrayAppend(contentBlock)
		item.ObjectSet("content", contentArr)
		wrapped.ArrayAppend(item)
		message.ObjectSet("input", wrapped)
		return responseInputRectifyResult{action: "string_to_array", originalType: "string"}
	}

	// Case 3: single object (MessageInput has role, ToolOutputsInput has type).
	if hasInput && input.IsObject() {
		if input.ObjectHas("role") || input.ObjectHas("type") {
			wrapped := ojson.NewArray()
			wrapped.ArrayAppend(input)
			message.ObjectSet("input", wrapped)
			return responseInputRectifyResult{action: "object_to_array", originalType: "object"}
		}
	}

	// Case 4: undefined/null/other -- passthrough, let downstream handle the error.
	return responseInputRectifyResult{action: "passthrough", originalType: "other"}
}

// ---- remote-compaction.ts#isRemoteCompactionV2Request ----

func isRemoteCompactionV2Request(pn string, body *ojson.Value) bool {
	if normalizeEndpointPath(pn) != "/v1/responses" {
		return false
	}
	if body == nil || !body.IsObject() {
		return false
	}

	input, ok := body.ObjectGet("input")
	if !ok {
		// items = [undefined]; typeof undefined !== "object" -> no match.
		return false
	}

	if input.IsArray() {
		for _, item := range input.ArrayItems() {
			if isCompactionTriggerItem(item) {
				return true
			}
		}
		return false
	}

	// items = [input] (single-object shorthand uses the same item semantics).
	return isCompactionTriggerItem(input)
}

func isCompactionTriggerItem(item *ojson.Value) bool {
	if item == nil || !item.IsObject() {
		return false
	}
	t, ok := item.ObjectGet("type")
	return ok && t.IsString() && t.String() == "compaction_trigger"
}

// ---- codex/session-completer.ts#extractInitialMessageTextHash ----

// extractInitialMessageTextHash ports extractInitialMessageTextHash
// (session-completer.ts ~L63-108). Callers only invoke this when body.input
// is a non-empty array (matching digest.ts's `Array.isArray(body.input) ? ... : null`).
func extractInitialMessageTextHash(body *ojson.Value) *string {
	input, ok := body.ObjectGet("input")
	if !ok || !input.IsArray() || input.ArrayLen() == 0 {
		return nil
	}

	var texts []string
	for _, item := range input.ArrayItems() {
		if item == nil || !item.IsObject() {
			continue
		}

		itemType := ""
		if tv, ok := item.ObjectGet("type"); ok && tv.IsString() {
			itemType = tv.String()
		}
		// Only consider "message" items for conversation fingerprinting.
		if itemType != "" && itemType != "message" {
			continue
		}

		content, hasContent := item.ObjectGet("content")
		if hasContent && content.IsString() {
			if jsTrim(content.String()) != "" {
				texts = append(texts, content.String())
			}
		} else if hasContent && content.IsArray() {
			var parts []string
			for _, part := range content.ArrayItems() {
				if part == nil || !part.IsObject() {
					continue
				}
				textVal, ok := part.ObjectGet("text")
				if !ok || !textVal.IsString() || textVal.String() == "" {
					continue
				}
				parts = append(parts, textVal.String())
			}
			joined := strings.Join(parts, "")
			if jsTrim(joined) != "" {
				texts = append(texts, joined)
			}
		}

		if len(texts) >= 3 {
			break
		}
	}

	if len(texts) == 0 {
		return nil
	}

	combined := strings.Join(texts, "|")
	sum := sha256.Sum256([]byte(combined))
	hash := hex.EncodeToString(sum[:])[:16]
	return &hash
}
