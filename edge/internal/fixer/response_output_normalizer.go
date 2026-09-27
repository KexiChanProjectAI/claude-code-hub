package fixer

import (
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

// NormalizeResponseOutput ports normalizeResponseOutputPayload
// (src/app/v1/_lib/proxy/response-output-normalizer.ts): for a non-stream
// OpenAI Responses API JSON body (top-level "object": "response"), replace
// null `output`/`tools` with `[]`, and within each `output[]` item replace
// null `content`/`summary` with `[]`, null `content[].text` with `""`, null
// `content[].annotations`/`content[].logprobs` with `[]`, and stringify any
// non-string `arguments` field (top-level on the item, on `item.function`,
// and on each `item.tool_calls[].function`) via JSON.stringify semantics
// (null/undefined -> "{}").
//
// Returns (body, false) unchanged when the body is not a JSON object with
// "object": "response", or when no field needed fixing.
//
// When to call this (see normalizeResponseOutput in the TS source and
// ResponseFixer.process / processNonStream):
//   - ONLY for the "response" (OpenAI Responses API) client format.
//   - ONLY for a non-stream (non-SSE) response body.
//   - ONLY when the response status is 2xx and content-type is JSON.
//   - It runs unconditionally whenever ResponseFixer.processNonStream runs,
//     regardless of the fixTruncatedJson/fixEncoding config flags -- but
//     ResponseFixer.process itself short-circuits and returns the response
//     untouched (skipping normalizeResponseOutput entirely) when the
//     response-fixer feature is disabled (settings.enableResponseFixer ===
//     false). So: call NormalizeResponseOutput iff the response-fixer
//     feature is enabled AND the response is non-stream AND
//     format == "response" AND status is 2xx AND content-type is JSON;
//     apply it to the body AFTER FixNonStream(body, cfg).
//   - It is NEVER applied to a streamed (SSE) Responses response: TS's
//     processStream has no equivalent call.
func NormalizeResponseOutput(body []byte) ([]byte, bool) {
	v, err := ojson.Parse(body, ojson.DefaultMaxDepth)
	if err != nil || !v.IsObject() {
		return body, false
	}

	objType, ok := v.ObjectGet("object")
	if !ok || !objType.IsString() || objType.String() != "response" {
		return body, false
	}

	applied := false

	if output, ok := v.ObjectGet("output"); ok {
		if output.IsNull() {
			v.ObjectSet("output", ojson.NewArray())
			applied = true
		} else if output.IsArray() {
			for _, item := range output.ArrayItems() {
				if normalizeOutputItem(item) {
					applied = true
				}
			}
		}
	}

	if tools, ok := v.ObjectGet("tools"); ok && tools.IsNull() {
		v.ObjectSet("tools", ojson.NewArray())
		applied = true
	}

	if !applied {
		return body, false
	}
	return v.Marshal(), true
}

func normalizeOutputItem(item *ojson.Value) bool {
	if !item.IsObject() {
		return false
	}
	changed := false

	if content, ok := item.ObjectGet("content"); ok {
		if content.IsNull() {
			item.ObjectSet("content", ojson.NewArray())
			changed = true
		} else if content.IsArray() {
			for _, part := range content.ArrayItems() {
				if normalizeContentPart(part) {
					changed = true
				}
			}
		}
	}

	if summary, ok := item.ObjectGet("summary"); ok && summary.IsNull() {
		item.ObjectSet("summary", ojson.NewArray())
		changed = true
	}

	if normalizeFunctionArguments(item, "arguments") {
		changed = true
	}

	if fn, ok := item.ObjectGet("function"); ok && fn.IsObject() {
		if normalizeFunctionArguments(fn, "arguments") {
			changed = true
		}
	}

	if toolCalls, ok := item.ObjectGet("tool_calls"); ok && toolCalls.IsArray() {
		for _, call := range toolCalls.ArrayItems() {
			if normalizeToolCall(call) {
				changed = true
			}
		}
	}

	return changed
}

func normalizeContentPart(part *ojson.Value) bool {
	if !part.IsObject() {
		return false
	}
	changed := false

	if text, ok := part.ObjectGet("text"); ok && text.IsNull() {
		part.ObjectSet("text", ojson.NewString(""))
		changed = true
	}
	if annotations, ok := part.ObjectGet("annotations"); ok && annotations.IsNull() {
		part.ObjectSet("annotations", ojson.NewArray())
		changed = true
	}
	if logprobs, ok := part.ObjectGet("logprobs"); ok && logprobs.IsNull() {
		part.ObjectSet("logprobs", ojson.NewArray())
		changed = true
	}

	return changed
}

func normalizeToolCall(call *ojson.Value) bool {
	if !call.IsObject() {
		return false
	}
	if fn, ok := call.ObjectGet("function"); ok && fn.IsObject() {
		return normalizeFunctionArguments(fn, "arguments")
	}
	return false
}

// normalizeFunctionArguments ports normalizeFunctionArguments +
// stringifyArguments: leaves an already-string `arguments` field untouched
// (mirrors the TS `normalized === value` no-op for strings), replaces
// null/undefined with the literal string "{}", and JSON.stringifies any
// other JSON value.
func normalizeFunctionArguments(target *ojson.Value, key string) bool {
	v, ok := target.ObjectGet(key)
	if !ok {
		return false
	}
	if v.IsString() {
		return false
	}
	normalized := "{}"
	if !v.IsNull() {
		normalized = string(v.Marshal())
	}
	target.ObjectSet(key, ojson.NewString(normalized))
	return true
}
