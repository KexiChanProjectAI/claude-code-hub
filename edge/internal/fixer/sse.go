package fixer

// SseFixer ports sse-fixer.ts.
type SseFixer struct{}

func NewSseFixer() *SseFixer { return &SseFixer{} }

const (
	lfByte byte = 0x0A
	crByte byte = 0x0D
)

var dataColon = []byte("data:")

func isAsciiWhitespace(b byte) bool {
	return b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D
}

func startsWithBytes(data []byte, prefix []byte) bool {
	if len(data) < len(prefix) {
		return false
	}
	for i, p := range prefix {
		if data[i] != p {
			return false
		}
	}
	return true
}

func toLowerASCII(b byte) byte {
	if b >= 0x41 && b <= 0x5A {
		return b + 0x20
	}
	return b
}

func includesDataColon(data []byte) bool {
	if len(data) < len(dataColon) {
		return false
	}
	for i := 0; i <= len(data)-len(dataColon); i++ {
		match := true
		for j := range dataColon {
			if data[i+j] != dataColon[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func looksLikeJSONLine(line []byte) bool {
	i := 0
	for i < len(line) && isAsciiWhitespace(line[i]) {
		i++
	}
	if i >= len(line) {
		return false
	}

	first := line[i]
	if first == 0x7B || first == 0x5B { // { or [
		return true
	}

	done := []byte("[DONE]")
	if len(line)-i >= len(done) {
		for j := 0; j < len(done); j++ {
			if line[i+j] != done[j] {
				return false
			}
		}
		return true
	}
	return false
}

func fixDataLine(line []byte) ([]byte, bool) {
	prefix := []byte("data:")
	if !startsWithBytes(line, prefix) {
		return line, false
	}
	after := line[len(prefix):]
	if len(after) > 0 && after[0] == 0x20 {
		return line, false
	}
	out := make([]byte, 0, len(prefix)+1+len(after))
	out = append(out, prefix...)
	out = append(out, 0x20)
	out = append(out, after...)
	return out, true
}

func fixFieldLine(line []byte, prefix []byte) ([]byte, bool) {
	if !startsWithBytes(line, prefix) {
		return line, false
	}
	after := line[len(prefix):]
	if len(after) > 0 && after[0] == 0x20 {
		return line, false
	}
	out := make([]byte, 0, len(prefix)+1+len(after))
	out = append(out, prefix...)
	out = append(out, 0x20)
	out = append(out, after...)
	return out, true
}

func tryFixMalformed(line []byte) ([]byte, bool, bool) {
	// returns (line, applied, matched) -- matched=false means "no rule applied at all" (TS returns null)
	dataPrefix := []byte("data")
	if startsWithBytes(line, dataPrefix) {
		rest := line[len(dataPrefix):]
		colonPos := -1
		for i := 0; i < len(rest); i++ {
			if rest[i] == 0x3A {
				colonPos = i
				break
			}
		}
		if colonPos >= 0 {
			ok := true
			for i := 0; i < colonPos; i++ {
				if !isAsciiWhitespace(rest[i]) {
					ok = false
					break
				}
			}
			if ok {
				afterColon := rest[colonPos+1:]
				j := 0
				for j < len(afterColon) && afterColon[j] == 0x20 {
					j++
				}
				trimmed := afterColon[j:]
				out := make([]byte, 0, 6+len(trimmed))
				out = append(out, 'd', 'a', 't', 'a', ':', ' ')
				out = append(out, trimmed...)
				return out, true, true
			}
		}
	}

	// Pattern 2: Data:/DATA: etc.
	if len(line) >= 5 {
		l0 := toLowerASCII(line[0])
		l1 := toLowerASCII(line[1])
		l2 := toLowerASCII(line[2])
		l3 := toLowerASCII(line[3])
		l4 := toLowerASCII(line[4])
		if l0 == 'd' && l1 == 'a' && l2 == 't' && l3 == 'a' && l4 == ':' {
			normalized := make([]byte, len(line))
			copy(normalized, []byte("data:"))
			copy(normalized[5:], line[5:])
			fixed, applied := fixDataLine(normalized)
			if applied {
				return fixed, true, true
			}
			return normalized, true, true
		}
	}

	return nil, false, false
}

func (f *SseFixer) CanFix(data []byte) bool {
	if startsWithBytes(data, []byte("data:")) ||
		startsWithBytes(data, []byte("event:")) ||
		startsWithBytes(data, []byte("id:")) ||
		startsWithBytes(data, []byte("retry:")) ||
		startsWithBytes(data, []byte(":")) {
		return true
	}

	if len(data) >= 4 {
		b0 := toLowerASCII(data[0])
		b1 := toLowerASCII(data[1])
		b2 := toLowerASCII(data[2])
		b3 := toLowerASCII(data[3])
		if b0 == 'd' && b1 == 'a' && b2 == 't' && b3 == 'a' {
			return true
		}
	}

	if looksLikeJSONLine(data) {
		return true
	}

	return includesDataColon(data)
}

func (f *SseFixer) fixLine(line []byte) ([]byte, bool) {
	if startsWithBytes(line, []byte("data:")) {
		return fixDataLine(line)
	}
	if startsWithBytes(line, []byte("event:")) {
		return fixFieldLine(line, []byte("event:"))
	}
	if startsWithBytes(line, []byte("id:")) {
		return fixFieldLine(line, []byte("id:"))
	}
	if startsWithBytes(line, []byte("retry:")) {
		return fixFieldLine(line, []byte("retry:"))
	}
	if startsWithBytes(line, []byte(":")) {
		return line, false
	}

	if looksLikeJSONLine(line) {
		out := make([]byte, 0, 6+len(line))
		out = append(out, 'd', 'a', 't', 'a', ':', ' ')
		out = append(out, line...)
		return out, true
	}

	if fixed, applied, matched := tryFixMalformed(line); matched {
		return fixed, applied
	}

	return line, false
}

// Fix mirrors SseFixer.fix.
func (f *SseFixer) Fix(input []byte) FixResult {
	if !f.CanFix(input) {
		return FixResult{Data: input, Applied: false}
	}

	var out [][]byte
	cursor := 0
	changed := false
	lastWasEmpty := false

	pos := 0
	for pos < len(input) {
		start := pos
		scan := start
		lineEnd := len(input)
		nextPos := len(input)
		newlineNormalized := false

		for scan < len(input) {
			b := input[scan]
			if b == lfByte {
				lineEnd = scan
				nextPos = scan + 1
				break
			}
			if b == crByte {
				lineEnd = scan
				nextPos = scan + 1
				if nextPos < len(input) && input[nextPos] == lfByte {
					nextPos++
				}
				newlineNormalized = true
				break
			}
			scan++
		}

		if nextPos == len(input) && lineEnd == len(input) {
			newlineNormalized = true
		}

		pos = nextPos
		line := input[start:lineEnd]

		if len(line) == 0 {
			if lastWasEmpty {
				changed = true
				if out == nil {
					if start > 0 {
						out = append(out, input[0:start])
					}
					cursor = start
				} else if cursor < start {
					out = append(out, input[cursor:start])
					cursor = start
				}
				cursor = pos
			} else if newlineNormalized {
				changed = true
				if out == nil {
					if start > 0 {
						out = append(out, input[0:start])
					}
					cursor = start
				} else if cursor < start {
					out = append(out, input[cursor:start])
					cursor = start
				}
				out = append(out, []byte{lfByte})
				cursor = pos
			} else if out != nil {
				out = append(out, input[cursor:pos])
				cursor = pos
			}
			lastWasEmpty = true
			continue
		}
		lastWasEmpty = false

		fixedLine, applied := f.fixLine(line)
		segmentChanged := applied || newlineNormalized
		if segmentChanged {
			changed = true
		}

		if segmentChanged {
			if out == nil {
				if start > 0 {
					out = append(out, input[0:start])
				}
				cursor = start
			} else if cursor < start {
				out = append(out, input[cursor:start])
				cursor = start
			}
			if applied {
				out = append(out, fixedLine)
			} else {
				out = append(out, line)
			}
			out = append(out, []byte{lfByte})
			cursor = pos
		} else if out != nil {
			out = append(out, input[cursor:pos])
			cursor = pos
		}
	}

	if out == nil {
		return FixResult{Data: input, Applied: false}
	}

	if cursor < len(input) {
		out = append(out, input[cursor:])
	}

	return FixResult{Data: concatBytes(out), Applied: changed}
}

func concatBytes(chunks [][]byte) []byte {
	total := 0
	for _, c := range chunks {
		total += len(c)
	}
	out := make([]byte, 0, total)
	for _, c := range chunks {
		out = append(out, c...)
	}
	return out
}
