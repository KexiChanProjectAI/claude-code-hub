package fixer

import (
	"bytes"
	"unicode/utf8"
)

// EncodingFixer ports encoding-fixer.ts.
type EncodingFixer struct{}

func NewEncodingFixer() *EncodingFixer { return &EncodingFixer{} }

func hasUTF8BOM(data []byte) bool {
	return len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF
}

func hasUTF16BOM(data []byte) bool {
	if len(data) < 2 {
		return false
	}
	return (data[0] == 0xFE && data[1] == 0xFF) || (data[0] == 0xFF && data[1] == 0xFE)
}

func stripBOM(data []byte) (out []byte, stripped bool, details string) {
	if hasUTF8BOM(data) {
		return data[3:], true, "removed_utf8_bom"
	}
	if hasUTF16BOM(data) {
		return data[2:], true, "removed_utf16_bom"
	}
	return data, false, ""
}

func stripNullBytes(data []byte) (out []byte, stripped bool) {
	firstNull := bytes.IndexByte(data, 0)
	if firstNull < 0 {
		return data, false
	}

	out = make([]byte, 0, len(data))
	out = append(out, data[:firstNull]...)
	for i := firstNull + 1; i < len(data); i++ {
		if data[i] != 0 {
			out = append(out, data[i])
		}
	}
	return out, true
}

func isValidUTF8(data []byte) bool {
	return utf8.Valid(data)
}

// CanFix mirrors EncodingFixer.canFix.
func (f *EncodingFixer) CanFix(data []byte) bool {
	if hasUTF8BOM(data) || hasUTF16BOM(data) {
		return true
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return true
	}
	return !isValidUTF8(data)
}

// Fix mirrors EncodingFixer.fix.
func (f *EncodingFixer) Fix(input []byte) FixResult {
	if !f.CanFix(input) {
		return FixResult{Data: input, Applied: false}
	}

	bomData, bomStripped, bomDetails := stripBOM(input)
	nulData, nulStripped := stripNullBytes(bomData)

	changedByStrip := bomStripped || nulStripped

	if isValidUTF8(nulData) {
		details := bomDetails
		if details == "" && nulStripped {
			details = "removed_null_bytes"
		}
		return FixResult{Data: nulData, Applied: changedByStrip, Details: details}
	}

	lossy := decodeUTF8Lossy(nulData)
	return FixResult{Data: lossy, Applied: true, Details: "lossy_utf8_decode_encode"}
}
