package ojson

import (
	"math"
	"strconv"
	"strings"
)

// FormatJSNumber formats f exactly the way JavaScript's Number.prototype.toString
// (and, for finite numbers, JSON.stringify) does: the ECMA-262 Number::toString
// algorithm. -0 formats as "0". NaN and +/-Infinity are not valid JSON numbers;
// they are formatted as "NaN", "Infinity", "-Infinity" respectively for
// completeness but callers should not feed them into JSON output.
func FormatJSNumber(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == 0 {
		return "0" // drops sign, matches (-0).toString() === "0"
	}

	neg := f < 0
	x := f
	if neg {
		x = -x
	}

	digits, n := shortestDigits(x)
	k := len(digits)

	var sb strings.Builder
	if neg {
		sb.WriteByte('-')
	}

	switch {
	case k <= n && n <= 21:
		sb.WriteString(digits)
		for i := 0; i < n-k; i++ {
			sb.WriteByte('0')
		}
	case 0 < n && n <= 21:
		sb.WriteString(digits[:n])
		sb.WriteByte('.')
		sb.WriteString(digits[n:])
	case -6 < n && n <= 0:
		sb.WriteString("0.")
		for i := 0; i < -n; i++ {
			sb.WriteByte('0')
		}
		sb.WriteString(digits)
	default:
		if k == 1 {
			sb.WriteString(digits)
		} else {
			sb.WriteString(digits[:1])
			sb.WriteByte('.')
			sb.WriteString(digits[1:])
		}
		sb.WriteByte('e')
		exp := n - 1
		if exp >= 0 {
			sb.WriteByte('+')
		} else {
			sb.WriteByte('-')
			exp = -exp
		}
		sb.WriteString(strconv.Itoa(exp))
	}

	return sb.String()
}

// shortestDigits returns the shortest round-trip decimal digit string for
// x > 0 (no leading/trailing zeros) and n such that 10^(n-1) <= x < 10^n.
func shortestDigits(x float64) (digits string, n int) {
	formatted := strconv.FormatFloat(x, 'e', -1, 64)
	// formatted looks like "d[.ddd]e±dd"
	eIdx := strings.IndexByte(formatted, 'e')
	mantissa := formatted[:eIdx]
	expPart := formatted[eIdx+1:]
	exp, err := strconv.Atoi(expPart)
	if err != nil {
		// unreachable for valid strconv output
		exp = 0
	}
	dotIdx := strings.IndexByte(mantissa, '.')
	if dotIdx == -1 {
		digits = mantissa
	} else {
		digits = mantissa[:dotIdx] + mantissa[dotIdx+1:]
	}
	n = exp + 1
	return digits, n
}
