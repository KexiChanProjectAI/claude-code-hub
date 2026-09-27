package fixer

// decodeUTF8Lossy re-encodes data as valid UTF-8, replacing each maximal
// invalid subsequence with exactly one U+FFFD, per the WHATWG Encoding
// Standard's UTF-8 decoder algorithm:
// https://encoding.spec.whatwg.org/#utf-8-decoder
//
// This matches JavaScript's `new TextDecoder("utf-8").decode(...)` (fatal:
// false) behavior, which differs from a naive Go utf8.DecodeRune loop in
// some multi-byte error cases (e.g. an overlong-encoding lead byte followed
// by a valid continuation byte for a *different* sequence: WHATWG emits one
// replacement for the lead byte and reprocesses the continuation byte,
// whereas some naive decoders emit one replacement per invalid byte).
const replacementChar = "�"

func decodeUTF8Lossy(data []byte) []byte {
	out := make([]byte, 0, len(data))

	var (
		codePoint   int32
		bytesSeen   int
		bytesNeeded int
		lowerBound  byte = 0x80
		upperBound  byte = 0xBF
	)

	reset := func() {
		codePoint = 0
		bytesSeen = 0
		bytesNeeded = 0
		lowerBound = 0x80
		upperBound = 0xBF
	}

	i := 0
	for i < len(data) {
		b := data[i]

		if bytesNeeded == 0 {
			switch {
			case b <= 0x7F:
				out = append(out, b)
				i++
			case b >= 0xC2 && b <= 0xDF:
				bytesNeeded = 1
				codePoint = int32(b & 0x1F)
				i++
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 {
					lowerBound = 0xA0
				}
				if b == 0xED {
					upperBound = 0x9F
				}
				bytesNeeded = 2
				codePoint = int32(b & 0x0F)
				i++
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 {
					lowerBound = 0x90
				}
				if b == 0xF4 {
					upperBound = 0x8F
				}
				bytesNeeded = 3
				codePoint = int32(b & 0x07)
				i++
			default:
				// Invalid lead byte: single error, consume the byte.
				out = append(out, replacementChar...)
				i++
			}
			continue
		}

		if b < lowerBound || b > upperBound {
			// Error; reset state and reprocess this same byte (do not advance i).
			reset()
			out = append(out, replacementChar...)
			continue
		}

		lowerBound = 0x80
		upperBound = 0xBF
		codePoint = (codePoint << 6) | int32(b&0x3F)
		bytesSeen++
		i++
		if bytesSeen != bytesNeeded {
			continue
		}

		out = appendRune(out, codePoint)
		reset()
	}

	// End of input with an incomplete sequence pending: one error.
	if bytesNeeded != 0 {
		out = append(out, replacementChar...)
	}

	return out
}

// appendRune appends the UTF-8 encoding of a validated code point (already
// known to be in range and not a surrogate, by construction of the decoder
// above) to out.
func appendRune(out []byte, r int32) []byte {
	switch {
	case r <= 0x7F:
		return append(out, byte(r))
	case r <= 0x7FF:
		return append(out,
			byte(0xC0|(r>>6)),
			byte(0x80|(r&0x3F)),
		)
	case r <= 0xFFFF:
		return append(out,
			byte(0xE0|(r>>12)),
			byte(0x80|((r>>6)&0x3F)),
			byte(0x80|(r&0x3F)),
		)
	default:
		return append(out,
			byte(0xF0|(r>>18)),
			byte(0x80|((r>>12)&0x3F)),
			byte(0x80|((r>>6)&0x3F)),
			byte(0x80|(r&0x3F)),
		)
	}
}
