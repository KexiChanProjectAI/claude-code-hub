package fixer

import (
	"encoding/json"
	"reflect"
	"testing"
)

type responseNormalizeCase struct {
	Name               string   `json:"name"`
	InputJSON          string   `json:"inputJson"`
	ExpectedApplied    bool     `json:"expectedApplied"`
	ExpectedOutputJSON string   `json:"expectedOutputJson"`
	ExpectedFixes      []string `json:"expectedFixes"`
}

func TestNormalizeResponseOutputFixtures(t *testing.T) {
	var cases []responseNormalizeCase
	loadFixture(t, "response-normalize.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			out, applied := NormalizeResponseOutput([]byte(c.InputJSON))

			if applied != c.ExpectedApplied {
				t.Fatalf("applied = %v, want %v", applied, c.ExpectedApplied)
			}

			// Compare parsed JSON (not bytes) since Go's ojson key order
			// matches JS insertion order but the fixture's expectedOutputJson
			// was produced by JSON.stringify on the same source object, so
			// bytes should already match -- parsed comparison is the robust
			// check either way.
			var gotVal, wantVal interface{}
			if err := json.Unmarshal(out, &gotVal); err != nil {
				t.Fatalf("output is not valid JSON: %v (%s)", err, out)
			}
			if err := json.Unmarshal([]byte(c.ExpectedOutputJSON), &wantVal); err != nil {
				t.Fatalf("fixture expectedOutputJson is not valid JSON: %v", err)
			}
			if !reflect.DeepEqual(gotVal, wantVal) {
				t.Errorf("output mismatch.\ngot:  %s\nwant: %s", out, c.ExpectedOutputJSON)
			}

			if !applied {
				// Unapplied cases must return the body unchanged (same bytes).
				if string(out) != c.InputJSON {
					t.Errorf("unapplied case returned different bytes.\ngot:  %s\nwant: %s", out, c.InputJSON)
				}
			}
		})
	}
}

func TestNormalizeResponseOutputNonJSONBody(t *testing.T) {
	out, applied := NormalizeResponseOutput([]byte("not json"))
	if applied {
		t.Fatalf("applied = true for non-JSON body")
	}
	if string(out) != "not json" {
		t.Fatalf("body changed for non-JSON input: %q", out)
	}
}

func TestNormalizeResponseOutputNonObjectBody(t *testing.T) {
	out, applied := NormalizeResponseOutput([]byte("[1,2,3]"))
	if applied {
		t.Fatalf("applied = true for array body")
	}
	if string(out) != "[1,2,3]" {
		t.Fatalf("body changed for array input: %q", out)
	}
}
