package redisx

import "testing"

func TestEncodeUsesByteLengths(t *testing.T) {
	encoded := string(encode([]string{"AUTH", "p a"}))
	if encoded != "*2\r\n$4\r\nAUTH\r\n$3\r\np a\r\n" {
		t.Fatalf("encoded = %q", encoded)
	}
}
