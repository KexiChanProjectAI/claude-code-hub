// Package digest builds contract.RequestDigest from a parsed request body,
// mirroring src/app/v1/_lib/edge/digest.ts buildRequestDigest (which in turn
// calls into ProxySession.isProbeRequest/isWarmupRequest,
// SessionManager.calculateMessagesHash and computeFingerprintChain).
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
	body := in.Body
	if body == nil || !body.IsObject() {
		// Mirrors the TS caller always passing a parsed object; when parsing
		// failed upstream we degrade to an empty object like TS would.
		body = ojson.NewObject()
	}

	return contract.RequestDigest{
		SchemaVersion:    contract.SchemaVersion,
		EdgeID:           in.EdgeID,
		EdgeRequestID:    in.EdgeRequestID,
		ReceivedAtMs:     in.ReceivedAtMs,
		Method:           in.Method,
		Path:             in.Path,
		Headers:          in.Headers,
		ClientIP:         in.ClientIP,
		BodyBytes:        in.BodyBytes,
		BodyParseError:   in.BodyParseError,
		TopLevel:         buildTopLevel(body),
		MessagesCount:    messagesCount(body),
		SystemKind:       resolveSystemKind(body),
		HasPrivateParams: hasPrivateKeys(body),
		IsProbe:          isProbeRequest(body),
		IsWarmup:         isWarmupRequest(body, in.Path),
		MessagesHash:     calculateMessagesHash(body),
		Fingerprint:      ComputeFingerprintChainClaude(body, MaxAffinityWindow),
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

func messagesCount(body *ojson.Value) int {
	if v, ok := body.ObjectGet("messages"); ok && v.IsArray() {
		return v.ArrayLen()
	}
	return 0
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

// isProbeRequest ports ProxySession.isProbeRequest (session.ts ~L1656).
func isProbeRequest(body *ojson.Value) bool {
	messages, ok := body.ObjectGet("messages")
	if !ok || !messages.IsArray() || messages.ArrayLen() != 1 {
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

// isWarmupRequest ports ProxySession.isWarmupRequest (session.ts ~L1688).
// The TS version first checks getEndpoint() === "/v1/messages".
func isWarmupRequest(body *ojson.Value, rawPath string) bool {
	if pathname(rawPath) != "/v1/messages" {
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
// (session-manager.ts ~L827-893).
func calculateMessagesHash(body *ojson.Value) *string {
	messages, ok := body.ObjectGet("messages")
	if !ok || !messages.IsArray() || messages.ArrayLen() == 0 {
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
