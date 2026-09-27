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

// ComputeFingerprintChainClaude ports computeFingerprintChain(message, "claude", window)
// from src/app/v1/_lib/proxy/affinity/fingerprint.ts. It fails open (returns nil)
// on any malformed input, matching the TS try/catch wrapper.
func ComputeFingerprintChainClaude(body *ojson.Value, window int) (chain *contract.FingerprintChain) {
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

	extracted := extractClaude(body)
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
