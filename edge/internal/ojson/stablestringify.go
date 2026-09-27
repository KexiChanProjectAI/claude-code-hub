package ojson

import (
	"bytes"
	"sort"
	"unicode/utf16"
)

// StableStringify ports src/lib/request-identity.ts stableStringify: object
// keys are sorted by UTF-16 code unit order (matching JS string comparison),
// arrays keep their order, and numbers are formatted via the float64 JS
// Number::toString algorithm (the value already went through JSON.parse in
// the JS reference, so any non-canonical literal - "1.0", "1e2", etc. - is
// normalized). No whitespace is emitted.
func StableStringify(v *Value) string {
	var buf bytes.Buffer
	writeStable(&buf, v)
	return buf.String()
}

func writeStable(buf *bytes.Buffer, v *Value) {
	if v == nil {
		buf.WriteString("null")
		return
	}
	switch v.kind {
	case KindNull:
		buf.WriteString("null")
	case KindBool:
		if v.b {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case KindNumber:
		f, err := v.Float64()
		if err != nil {
			buf.WriteString("null")
			return
		}
		buf.WriteString(FormatJSNumber(f))
	case KindString:
		writeJSONString(buf, v.str)
	case KindArray:
		buf.WriteByte('[')
		for i, item := range v.arr {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeStable(buf, item)
		}
		buf.WriteByte(']')
	case KindObject:
		buf.WriteByte('{')
		if v.obj != nil {
			keys := make([]string, len(v.obj.keys))
			copy(keys, v.obj.keys)
			sort.Slice(keys, func(i, j int) bool { return LessUTF16(keys[i], keys[j]) })
			for i, k := range keys {
				if i > 0 {
					buf.WriteByte(',')
				}
				writeJSONString(buf, k)
				buf.WriteByte(':')
				val, _ := v.obj.get(k)
				writeStable(buf, val)
			}
		}
		buf.WriteByte('}')
	}
}

// LessUTF16 compares a and b the way JavaScript's `<` operator on strings
// does: lexicographic comparison of UTF-16 code units (not Unicode code
// points), so astral characters compare as their surrogate-pair units.
func LessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	n := len(ua)
	if len(ub) < n {
		n = len(ub)
	}
	for i := 0; i < n; i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
