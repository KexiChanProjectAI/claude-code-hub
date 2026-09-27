package fixer

import (
	"bytes"
	"testing"
)

type encodingCase struct {
	Name              string `json:"name"`
	InputB64          string `json:"inputB64"`
	ExpectedDataB64   string `json:"expectedDataB64"`
	ExpectedApplied   bool   `json:"expectedApplied"`
	ExpectedDetails   string `json:"expectedDetails"`
	ExpectedDetailsOK bool   `json:"-"`
}

func TestEncodingFixerFixtures(t *testing.T) {
	var raw []map[string]interface{}
	loadFixture(t, "encoding.json", &raw)

	var cases []encodingCase
	loadFixture(t, "encoding.json", &cases)

	for i, c := range cases {
		c := c
		hasDetails := raw[i]["expectedDetails"] != nil
		t.Run(c.Name, func(t *testing.T) {
			input := mustB64(t, c.InputB64)
			expected := mustB64(t, c.ExpectedDataB64)

			res := NewEncodingFixer().Fix(input)
			if res.Applied != c.ExpectedApplied {
				t.Errorf("Applied = %v, want %v", res.Applied, c.ExpectedApplied)
			}
			if !bytes.Equal(res.Data, expected) {
				t.Errorf("Data = %q, want %q", res.Data, expected)
			}
			if hasDetails {
				if res.Details != c.ExpectedDetails {
					t.Errorf("Details = %q, want %q", res.Details, c.ExpectedDetails)
				}
			} else if res.Details != "" {
				t.Errorf("Details = %q, want empty", res.Details)
			}
		})
	}
}
