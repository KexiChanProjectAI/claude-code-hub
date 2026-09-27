package fixer

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

type jsonCase struct {
	Name                      string          `json:"name"`
	InputB64                  string          `json:"inputB64"`
	MaxDepth                  int             `json:"maxDepth"`
	MaxSize                   int             `json:"maxSize"`
	ExpectedApplied           bool            `json:"expectedApplied"`
	ExpectedDetails           *string         `json:"expectedDetails"`
	ExpectedDataB64           string          `json:"expectedDataB64"`
	ExpectAppliedDataParsesTo json.RawMessage `json:"expectAppliedDataParsesTo"`
}

func TestJsonFixerFixtures(t *testing.T) {
	var cases []jsonCase
	loadFixture(t, "json.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			input := mustB64(t, c.InputB64)

			res := NewJsonFixer(c.MaxDepth, c.MaxSize).Fix(input)
			if res.Applied != c.ExpectedApplied {
				t.Fatalf("Applied = %v, want %v", res.Applied, c.ExpectedApplied)
			}
			wantDetails := ""
			if c.ExpectedDetails != nil {
				wantDetails = *c.ExpectedDetails
			}
			if res.Details != wantDetails {
				t.Errorf("Details = %q, want %q", res.Details, wantDetails)
			}

			if len(c.ExpectAppliedDataParsesTo) > 0 {
				var got, want interface{}
				if err := json.Unmarshal(res.Data, &got); err != nil {
					t.Fatalf("repaired data is not valid JSON: %v (data=%s)", err, res.Data)
				}
				if err := json.Unmarshal(c.ExpectAppliedDataParsesTo, &want); err != nil {
					t.Fatalf("bad fixture expectAppliedDataParsesTo: %v", err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("parsed repaired data = %#v, want %#v", got, want)
				}
				return
			}

			expected := mustB64(t, c.ExpectedDataB64)
			if !bytes.Equal(res.Data, expected) {
				t.Errorf("Data = %q, want %q", res.Data, expected)
			}
		})
	}
}
