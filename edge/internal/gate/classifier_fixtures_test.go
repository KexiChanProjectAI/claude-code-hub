package gate

import (
	"encoding/json"
	"os"
	"testing"
)

func loadFixture(t *testing.T, name string, v any) {
	t.Helper()
	path := "../../../tests/fixtures/edge/gate/" + name
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parse fixture %s: %v", path, err)
	}
}

type classifierCaseJSON struct {
	Family    string  `json:"family"`
	EventName *string `json:"eventName"`
	Data      string  `json:"data"`
	Expected  struct {
		Verdict        string `json:"verdict"`
		AcceptTerminal bool   `json:"acceptTerminal"`
		IsEcho         bool   `json:"isEcho"`
		TerminalKind   string `json:"terminalKind"`
	} `json:"expected"`
}

func TestClassifierFixtures(t *testing.T) {
	var cases []classifierCaseJSON
	loadFixture(t, "classifier.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for i, c := range cases {
		c := c
		got := ClassifyFrame(Family(c.Family), c.EventName, c.Data)
		if string(got.Verdict) != c.Expected.Verdict {
			t.Errorf("case[%d] family=%s event=%v data=%q: verdict = %s, want %s",
				i, c.Family, ptrStr(c.EventName), c.Data, got.Verdict, c.Expected.Verdict)
		}
		if got.AcceptTerminal != c.Expected.AcceptTerminal {
			t.Errorf("case[%d] family=%s event=%v data=%q: acceptTerminal = %v, want %v",
				i, c.Family, ptrStr(c.EventName), c.Data, got.AcceptTerminal, c.Expected.AcceptTerminal)
		}
		if got.IsEcho != c.Expected.IsEcho {
			t.Errorf("case[%d] family=%s event=%v data=%q: isEcho = %v, want %v",
				i, c.Family, ptrStr(c.EventName), c.Data, got.IsEcho, c.Expected.IsEcho)
		}
		if got.TerminalKind != c.Expected.TerminalKind {
			t.Errorf("case[%d] family=%s event=%v data=%q: terminalKind = %q, want %q",
				i, c.Family, ptrStr(c.EventName), c.Data, got.TerminalKind, c.Expected.TerminalKind)
		}
	}
}

func TestFamilyForProviderType(t *testing.T) {
	cases := map[string]Family{
		"claude":            FamilyAnthropic,
		"claude-auth":       FamilyAnthropic,
		"codex":             FamilyOpenAIResponses,
		"openai-compatible": FamilyOpenAIChat,
		"gemini":            FamilyGemini,
		"gemini-cli":        FamilyGemini,
	}
	for in, want := range cases {
		got, ok := FamilyForProviderType(in)
		if !ok || got != want {
			t.Errorf("FamilyForProviderType(%q) = %q, %v; want %q, true", in, got, ok, want)
		}
	}
	if _, ok := FamilyForProviderType("unknown-provider"); ok {
		t.Error("FamilyForProviderType(unknown) should return ok=false")
	}
}

func ptrStr(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
