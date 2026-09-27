package fixer

import "encoding/json"

// JsonFixer ports json-fixer.ts.
type JsonFixer struct {
	maxDepth int
	maxSize  int
}

func NewJsonFixer(maxDepth, maxSize int) *JsonFixer {
	return &JsonFixer{maxDepth: maxDepth, maxSize: maxSize}
}

func isWhitespace(b byte) bool {
	return b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D
}

func looksLikeJSON(data []byte) bool {
	for _, b := range data {
		if isWhitespace(b) {
			continue
		}
		return b == 0x7B || b == 0x5B // { or [
	}
	return false
}

func removeTrailingComma(bytes *[]byte) {
	b := *bytes
	idx := len(b) - 1
	for idx >= 0 && isWhitespace(b[idx]) {
		idx--
	}
	if idx >= 0 && b[idx] == 0x2C { // ,
		*bytes = b[:idx]
	}
}

func needsNullValue(bytes []byte, stack []byte) bool {
	if len(stack) == 0 || stack[len(stack)-1] != 0x7D { // }
		return false
	}
	idx := len(bytes) - 1
	for idx >= 0 && isWhitespace(bytes[idx]) {
		idx--
	}
	return idx >= 0 && bytes[idx] == 0x3A // :
}

func (f *JsonFixer) CanFix(data []byte) bool {
	return looksLikeJSON(data)
}

// Fix mirrors JsonFixer.fix.
func (f *JsonFixer) Fix(data []byte) FixResult {
	if len(data) > f.maxSize {
		return FixResult{Data: data, Applied: false, Details: "exceeded_max_size"}
	}

	if !f.CanFix(data) {
		return FixResult{Data: data, Applied: false}
	}

	// TS validates via `JSON.parse(TextDecoder.decode(data))`, i.e. against the
	// lossily-decoded text (invalid UTF-8 becomes U+FFFD before parsing), not
	// the raw bytes. Mirror that so a JSON-syntax-only fixer decision does not
	// also depend on separately-scoped encoding issues.
	if json.Valid(decodeUTF8Lossy(data)) {
		return FixResult{Data: data, Applied: false}
	}

	repaired := f.repair(data)
	if repaired == nil {
		return FixResult{Data: data, Applied: false, Details: "repair_failed"}
	}

	if json.Valid(decodeUTF8Lossy(repaired)) {
		return FixResult{Data: repaired, Applied: true}
	}
	return FixResult{Data: data, Applied: false, Details: "validate_repaired_failed"}
}

func (f *JsonFixer) repair(data []byte) []byte {
	out := make([]byte, 0, len(data)+8)
	var stack []byte

	inString := false
	escapeNext := false
	depth := 0

	for _, b := range data {
		if escapeNext {
			escapeNext = false
			out = append(out, b)
			continue
		}

		if inString && b == 0x5C { // backslash
			escapeNext = true
			out = append(out, b)
			continue
		}

		if b == 0x22 { // "
			inString = !inString
			out = append(out, b)
			continue
		}

		if !inString {
			switch b {
			case 0x7B: // {
				depth++
				if depth > f.maxDepth {
					return nil
				}
				stack = append(stack, 0x7D)
				out = append(out, b)
				continue
			case 0x5B: // [
				depth++
				if depth > f.maxDepth {
					return nil
				}
				stack = append(stack, 0x5D)
				out = append(out, b)
				continue
			case 0x7D: // }
				removeTrailingComma(&out)
				if len(stack) > 0 && stack[len(stack)-1] == b {
					stack = stack[:len(stack)-1]
					if depth > 0 {
						depth--
					}
					out = append(out, b)
				}
				continue
			case 0x5D: // ]
				removeTrailingComma(&out)
				if len(stack) > 0 && stack[len(stack)-1] == b {
					stack = stack[:len(stack)-1]
					if depth > 0 {
						depth--
					}
					out = append(out, b)
				}
				continue
			}
		}

		out = append(out, b)
	}

	if escapeNext && len(out) > 0 {
		out = out[:len(out)-1]
	}

	if inString {
		out = append(out, 0x22)
	}

	removeTrailingComma(&out)

	if needsNullValue(out, stack) {
		out = append(out, 'n', 'u', 'l', 'l')
	}

	for len(stack) > 0 {
		removeTrailingComma(&out)
		out = append(out, stack[len(stack)-1])
		stack = stack[:len(stack)-1]
	}

	return out
}
