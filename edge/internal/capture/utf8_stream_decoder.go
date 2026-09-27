package capture

import "strings"

// utf8StreamDecoder incrementally decodes UTF-8 bytes into Go strings the
// way JavaScript's `new TextDecoder("utf-8").decode(chunk, {stream: true})`
// does: it never emits an error for a multi-byte sequence that is merely
// incomplete at the end of a Push() call (the tail bytes are held across
// calls); Finish() flushes the decoder the way a final non-streaming
// decode() call would, turning any still-pending partial sequence into a
// single U+FFFD. See https://encoding.spec.whatwg.org/#utf-8-decoder.
type utf8StreamDecoder struct {
	codePoint   int32
	bytesSeen   int
	bytesNeeded int
	lowerBound  byte
	upperBound  byte
}

func newUTF8StreamDecoder() *utf8StreamDecoder {
	return &utf8StreamDecoder{lowerBound: 0x80, upperBound: 0xBF}
}

func (d *utf8StreamDecoder) reset() {
	d.codePoint = 0
	d.bytesSeen = 0
	d.bytesNeeded = 0
	d.lowerBound = 0x80
	d.upperBound = 0xBF
}

func (d *utf8StreamDecoder) Push(data []byte) string {
	var sb strings.Builder
	sb.Grow(len(data))

	i := 0
	for i < len(data) {
		b := data[i]

		if d.bytesNeeded == 0 {
			switch {
			case b <= 0x7F:
				sb.WriteByte(b)
				i++
			case b >= 0xC2 && b <= 0xDF:
				d.bytesNeeded = 1
				d.codePoint = int32(b & 0x1F)
				i++
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 {
					d.lowerBound = 0xA0
				}
				if b == 0xED {
					d.upperBound = 0x9F
				}
				d.bytesNeeded = 2
				d.codePoint = int32(b & 0x0F)
				i++
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 {
					d.lowerBound = 0x90
				}
				if b == 0xF4 {
					d.upperBound = 0x8F
				}
				d.bytesNeeded = 3
				d.codePoint = int32(b & 0x07)
				i++
			default:
				sb.WriteRune('�')
				i++
			}
			continue
		}

		if b < d.lowerBound || b > d.upperBound {
			d.reset()
			sb.WriteRune('�')
			continue // reprocess this same byte with fresh state
		}

		d.lowerBound = 0x80
		d.upperBound = 0xBF
		d.codePoint = (d.codePoint << 6) | int32(b&0x3F)
		d.bytesSeen++
		i++
		if d.bytesSeen != d.bytesNeeded {
			continue
		}
		sb.WriteRune(rune(d.codePoint))
		d.reset()
	}

	return sb.String()
}

// Finish flushes any pending incomplete sequence into a single U+FFFD.
func (d *utf8StreamDecoder) Finish() string {
	if d.bytesNeeded != 0 {
		d.reset()
		return "�"
	}
	return ""
}
