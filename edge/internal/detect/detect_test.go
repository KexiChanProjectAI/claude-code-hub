package detect

import (
	"encoding/json"
	"os"
	"testing"
)

const fixtureDir = "../../../tests/fixtures/edge/body"

type detectCase struct {
	Name     string `json:"name"`
	BodyText string `json:"bodyText"`
	Expected struct {
		IsError bool   `json:"isError"`
		Code    string `json:"code"`
	} `json:"expected"`
}

func TestSuspectNonStreamFixtures(t *testing.T) {
	data, err := os.ReadFile(fixtureDir + "/detect.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []detectCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := SuspectNonStream([]byte(c.BodyText), "application/json")
			if got != c.Expected.IsError {
				t.Fatalf("SuspectNonStream(%q) = %v, want %v (ts code=%q)", c.BodyText, got, c.Expected.IsError, c.Expected.Code)
			}
		})
	}
}

func TestEmptyReason(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"empty", "", "empty_body"},
		{"whitespace", "   \n", "empty_body"},
		{"claude_missing_content", `{"type":"message","content":[]}`, "missing_content"},
		{"claude_has_content", `{"type":"message","content":[{"type":"text","text":"hi"}]}`, ""},
		{"openai_missing_choices", `{"choices":[]}`, "missing_content"},
		{"openai_has_choices", `{"choices":[{"index":0}]}`, ""},
		{"malformed_json", "{not json", ""},
		{"unrelated_json", `{"foo":"bar"}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := EmptyReason([]byte(c.body))
			if got != c.want {
				t.Fatalf("EmptyReason(%q) = %q, want %q", c.body, got, c.want)
			}
		})
	}
}
