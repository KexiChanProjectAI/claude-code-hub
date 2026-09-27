package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

// sep mirrors SEP in affinity/fingerprint.ts: `const SEP = "\x1f";` (ASCII unit
// separator), not an empty string as it might appear when the source is
// rendered by tools that strip control characters.
const sep = "\x1f"

// MaxAffinityWindow mirrors MAX_AFFINITY_WINDOW in affinity/fingerprint.ts.
const MaxAffinityWindow = 64

// DefaultAffinityWindow mirrors DEFAULT_AFFINITY_WINDOW.
const DefaultAffinityWindow = 8

var volatileKeys = map[string]bool{
	"id": true, "call_id": true, "tool_use_id": true, "tool_call_id": true, "cache_control": true,
}

type normalizedMessage struct {
	bytes           string
	hasCacheControl bool
}

// ComputeFingerprintChain ports computeFingerprintChain(message, format, window)
// from src/app/v1/_lib/proxy/affinity/fingerprint.ts for format in
// {claude, openai, response} (the edge-supported EdgeClientFormat set; other
// formats fall through extractConversation's default case and return nil,
// matching computeChainInner's null on an unrecognized format). It fails open
// (returns nil) on any malformed input, matching the TS try/catch wrapper.
func ComputeFingerprintChain(body *ojson.Value, format string, window int) (chain *contract.FingerprintChain) {
	defer func() {
		if r := recover(); r != nil {
			chain = nil
		}
	}()
	if window <= 0 {
		window = DefaultAffinityWindow
	}
	if window > MaxAffinityWindow {
		window = MaxAffinityWindow
	}

	extracted := extractConversation(body, format)
	if extracted == nil {
		return nil
	}

	sysBytes := joinStrings(extracted.sysSegments)
	sysFP := h32(sysBytes)
	cumBytes := byteLen(sysBytes)
	sys := contract.FingerprintBoundary{Depth: 0, FP: sysFP, PrefixBytes: cumBytes}

	tail := make([]contract.FingerprintBoundary, 0, len(extracted.messages))
	prev := sysFP
	depth := 0
	for _, m := range extracted.messages {
		if len(m.bytes) == 0 {
			continue
		}
		depth++
		prev = h32(prev + m.bytes)
		cumBytes += byteLen(m.bytes)
		b := contract.FingerprintBoundary{Depth: depth, FP: prev, PrefixBytes: cumBytes}
		if m.hasCacheControl {
			b.HasCacheControl = true
		}
		tail = append(tail, b)
	}

	if len(tail) > window {
		tail = tail[len(tail)-window:]
	}

	return &contract.FingerprintChain{Sys: sys, Tail: tail}
}

func h32(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:32]
}

func byteLen(s string) int { return len(s) }

func joinStrings(parts []string) string {
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	out := make([]byte, 0, total)
	for _, p := range parts {
		out = append(out, p...)
	}
	return string(out)
}

type extractedConversation struct {
	sysSegments []string
	messages    []normalizedMessage
}

// extractConversation ports the switch in computeChainInner (fingerprint.ts
// extractConversation), restricted to the edge-supported formats: claude,
// openai, response. gemini/gemini-cli never reach the edge digest (their
// paths resolve to "claude" via resolveEdgeClientFormat), so they are not
// ported here; any other format value falls through to nil, matching the
// TS `default: return null`.
func extractConversation(body *ojson.Value, format string) *extractedConversation {
	switch format {
	case contract.FormatClaude:
		return extractClaude(body)
	case contract.FormatOpenAI:
		return extractOpenAIChat(body)
	case contract.FormatResponse:
		return extractResponses(body)
	default:
		return nil
	}
}

func extractClaude(body *ojson.Value) *extractedConversation {
	messages, ok := body.ObjectGet("messages")
	if !ok || !messages.IsArray() {
		return nil
	}

	sysSegments := []string{sep}
	if system, ok := body.ObjectGet("system"); ok {
		if system.IsString() {
			sysSegments = append(sysSegments, system.String())
		} else if system.IsArray() {
			for _, block := range system.ArrayItems() {
				sysSegments = append(sysSegments, normalizeContentBlock(block))
			}
		}
	}
	if tools, ok := body.ObjectGet("tools"); ok {
		appendTools(&sysSegments, tools, func(tool *ojson.Value) toolSpec {
			return toolSpec{
				name:        readString(tool, "name"),
				description: readString(tool, "description"),
				parameters:  readRecord(tool, "input_schema"),
			}
		})
	}

	normalized := make([]normalizedMessage, 0, messages.ArrayLen())
	for _, raw := range messages.ArrayItems() {
		if !raw.IsObject() {
			continue
		}
		parts := []string{sep, readString(raw, "role")}
		hasCacheControl := false
		if content, ok := raw.ObjectGet("content"); ok {
			if content.IsString() {
				parts = append(parts, sep, "text:", content.String())
			} else if content.IsArray() {
				for _, block := range content.ArrayItems() {
					parts = append(parts, normalizeContentBlock(block))
					if block.IsObject() {
						if cc, ok := block.ObjectGet("cache_control"); ok && !cc.IsNull() {
							hasCacheControl = true
						}
					}
				}
			}
		}
		normalized = append(normalized, finishMessage(parts, hasCacheControl))
	}

	return &extractedConversation{sysSegments: sysSegments, messages: normalized}
}

func normalizeContentBlock(block *ojson.Value) string {
	if block == nil || !block.IsObject() {
		if block != nil && block.IsString() {
			return sep + "text:" + block.String()
		}
		return ""
	}
	typ := readString(block, "type")
	switch typ {
	case "text":
		return sep + "text:" + readString(block, "text")
	case "thinking":
		return sep + "thinking:" + readString(block, "thinking")
	case "redacted_thinking":
		return sep + "redacted_thinking:" + readString(block, "data")
	case "tool_use":
		input, _ := block.ObjectGet("input")
		return sep + "tool_use:" + readString(block, "name") + ":" + ojson.StableStringify(input)
	case "tool_result":
		content, _ := block.ObjectGet("content")
		return sep + "tool_result:" + serializeUnknownContent(content)
	case "image", "document":
		source := readRecord(block, "source")
		return sep + typ + ":" + digestMediaSource(source)
	default:
		if typ == "" {
			return ""
		}
		return sep + typ + ":" + ojson.StableStringify(stripVolatileKeys(block))
	}
}

func digestMediaSource(source *ojson.Value) string {
	if source == nil {
		return ""
	}
	mediaType := readString(source, "media_type")
	if mediaType == "" {
		mediaType = readString(source, "mediaType")
	}
	data := readString(source, "data")
	if data != "" {
		return mediaType + ":" + h32(data)
	}
	url := readString(source, "url")
	return mediaType + ":" + url
}

// ===== openai (Chat Completions) =====

func extractOpenAIChat(body *ojson.Value) *extractedConversation {
	messages, ok := body.ObjectGet("messages")
	if !ok || !messages.IsArray() {
		return nil
	}

	sysSegments := []string{sep}
	if tools, ok := body.ObjectGet("tools"); ok {
		appendTools(&sysSegments, tools, func(tool *ojson.Value) toolSpec {
			fn := readRecord(tool, "function")
			if fn != nil {
				return toolSpec{
					name:        readString(fn, "name"),
					description: readString(fn, "description"),
					parameters:  readRecord(fn, "parameters"),
				}
			}
			return toolSpec{
				name:        readString(tool, "name"),
				description: readString(tool, "description"),
				parameters:  nil,
			}
		})
	}

	normalized := make([]normalizedMessage, 0, messages.ArrayLen())
	inLeadingSystem := true
	for _, raw := range messages.ArrayItems() {
		if raw == nil || !raw.IsObject() {
			continue
		}
		role := readString(raw, "role")
		content, _ := raw.ObjectGet("content")
		// Leading system/developer messages belong to the cross-conversation
		// stable segment and are folded into F_sys.
		if inLeadingSystem && (role == "system" || role == "developer") {
			sysSegments = append(sysSegments, sep, role, ":", serializeUnknownContent(content))
			continue
		}
		inLeadingSystem = false

		parts := []string{sep, role}
		parts = append(parts, sep, "content:", serializeUnknownContent(content))
		if toolCalls, ok := raw.ObjectGet("tool_calls"); ok && toolCalls.IsArray() {
			for _, call := range toolCalls.ArrayItems() {
				if call == nil || !call.IsObject() {
					continue
				}
				fn := readRecord(call, "function")
				fnName, fnArgs := "", ""
				if fn != nil {
					fnName = readString(fn, "name")
					fnArgs = readString(fn, "arguments")
				}
				// Strip the volatile call id.
				parts = append(parts, sep, "tool_call:", fnName, ":", fnArgs)
			}
		}
		if raw.ObjectHas("tool_call_id") {
			// tool-role message: strip tool_call_id, content already captured above.
			parts = append(parts, sep, "tool_result")
		}
		normalized = append(normalized, finishMessage(parts, false))
	}

	return &extractedConversation{sysSegments: sysSegments, messages: normalized}
}

// ===== response (OpenAI Responses / Codex) =====

func extractResponses(body *ojson.Value) *extractedConversation {
	input, hasInput := body.ObjectGet("input")

	sysSegments := []string{sep}
	if instructions, ok := body.ObjectGet("instructions"); ok && instructions.IsString() {
		sysSegments = append(sysSegments, instructions.String())
	}
	if tools, ok := body.ObjectGet("tools"); ok {
		appendTools(&sysSegments, tools, func(tool *ojson.Value) toolSpec {
			return toolSpec{
				name:        readString(tool, "name"),
				description: readString(tool, "description"),
				parameters:  readRecord(tool, "parameters"),
			}
		})
	}

	var normalized []normalizedMessage
	switch {
	case hasInput && input.IsString():
		normalized = append(normalized, normalizedMessage{
			bytes:           sep + "user" + sep + "text:" + input.String(),
			hasCacheControl: false,
		})
	case hasInput && input.IsArray():
		normalized = make([]normalizedMessage, 0, input.ArrayLen())
		for _, raw := range input.ArrayItems() {
			if raw == nil || !raw.IsObject() {
				continue
			}
			typ := readString(raw, "type")
			if typ == "" {
				typ = "message"
			}
			parts := []string{sep}
			switch typ {
			case "message":
				content, _ := raw.ObjectGet("content")
				parts = append(parts, readString(raw, "role"), sep, "content:", serializeUnknownContent(content))
			case "function_call":
				// Strip the volatile call_id / id.
				parts = append(parts, "function_call", sep, readString(raw, "name"), ":", readString(raw, "arguments"))
			case "function_call_output":
				output, _ := raw.ObjectGet("output")
				parts = append(parts, "function_call_output", sep, serializeUnknownContent(output))
			case "reasoning":
				summaryOrContent := nullishCoalesce(raw, "summary", "content")
				parts = append(parts, "reasoning", sep, serializeUnknownContent(summaryOrContent))
			default:
				parts = append(parts, typ, sep, ojson.StableStringify(stripVolatileKeys(raw)))
			}
			normalized = append(normalized, finishMessage(parts, false))
		}
	default:
		return nil
	}

	return &extractedConversation{sysSegments: sysSegments, messages: normalized}
}

// nullishCoalesce reads record[primaryKey], falling back to record[fallbackKey]
// only when primaryKey is absent or explicitly null (mirrors JS `a ?? b`, which
// only falls through on null/undefined -- not on other falsy values).
func nullishCoalesce(record *ojson.Value, primaryKey, fallbackKey string) *ojson.Value {
	if v, ok := record.ObjectGet(primaryKey); ok && !v.IsNull() {
		return v
	}
	if v, ok := record.ObjectGet(fallbackKey); ok {
		return v
	}
	return nil
}

type toolSpec struct {
	name        string
	description string
	parameters  *ojson.Value
}

func appendTools(segments *[]string, tools *ojson.Value, project func(*ojson.Value) toolSpec) {
	if tools == nil || !tools.IsArray() || tools.ArrayLen() == 0 {
		return
	}
	specs := make([]toolSpec, 0, tools.ArrayLen())
	for _, raw := range tools.ArrayItems() {
		if raw == nil || !raw.IsObject() {
			continue
		}
		spec := project(raw)
		if spec.name == "" {
			continue
		}
		specs = append(specs, spec)
	}
	sort.SliceStable(specs, func(i, j int) bool { return ojson.LessUTF16(specs[i].name, specs[j].name) })
	for _, spec := range specs {
		params := ""
		if spec.parameters != nil {
			params = ojson.StableStringify(spec.parameters)
		}
		*segments = append(*segments, sep, spec.name, ":", spec.description, ":", params)
	}
}

func finishMessage(parts []string, hasCacheControl bool) normalizedMessage {
	bytesStr := joinStrings(parts)
	meaningful := len(parts) > 2
	if !meaningful {
		return normalizedMessage{bytes: "", hasCacheControl: hasCacheControl}
	}
	return normalizedMessage{bytes: bytesStr, hasCacheControl: hasCacheControl}
}

func serializeUnknownContent(content *ojson.Value) string {
	if content == nil || content.IsNull() {
		return ""
	}
	if content.IsString() {
		return content.String()
	}
	return ojson.StableStringify(content)
}

func stripVolatileKeys(record *ojson.Value) *ojson.Value {
	out := ojson.NewObject()
	if record == nil || !record.IsObject() {
		return out
	}
	for _, k := range record.ObjectKeys() {
		if volatileKeys[k] {
			continue
		}
		v, _ := record.ObjectGet(k)
		out.ObjectSet(k, v)
	}
	return out
}

func readString(record *ojson.Value, key string) string {
	if record == nil || !record.IsObject() {
		return ""
	}
	v, ok := record.ObjectGet(key)
	if !ok || !v.IsString() {
		return ""
	}
	return v.String()
}

func readRecord(record *ojson.Value, key string) *ojson.Value {
	if record == nil || !record.IsObject() {
		return nil
	}
	v, ok := record.ObjectGet(key)
	if !ok || !v.IsObject() {
		return nil
	}
	return v
}
