package fixer

import (
	"bytes"
	"testing"
)

type sseCase struct {
	Name            string `json:"name"`
	InputB64        string `json:"inputB64"`
	ExpectedDataB64 string `json:"expectedDataB64"`
	ExpectedApplied bool   `json:"expectedApplied"`
}

func TestSseFixerFixtures(t *testing.T) {
	var cases []sseCase
	loadFixture(t, "sse.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			input := mustB64(t, c.InputB64)
			expected := mustB64(t, c.ExpectedDataB64)

			res := NewSseFixer().Fix(input)
			if res.Applied != c.ExpectedApplied {
				t.Errorf("Applied = %v, want %v", res.Applied, c.ExpectedApplied)
			}
			if !bytes.Equal(res.Data, expected) {
				t.Errorf("Data = %q, want %q", res.Data, expected)
			}
		})
	}
}
