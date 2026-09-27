package bodyops

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

const fixtureDir = "../../../tests/fixtures/edge/body"

type bodyOpsCase struct {
	Name              string            `json:"name"`
	Body              string            `json:"body"`
	Ops               []contract.BodyOp `json:"ops"`
	ExpectedBody      string            `json:"expectedBody"`
	ExpectedOpResults json.RawMessage   `json:"expectedOpResults"`
}

func TestApplyFixtures(t *testing.T) {
	data, err := os.ReadFile(fixtureDir + "/bodyops.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []bodyOpsCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			body, err := ojson.Parse([]byte(c.Body), 0)
			if err != nil {
				t.Fatalf("parse body: %v", err)
			}
			original := string(body.Marshal())

			got, opResults, err := Apply(body, c.Ops)
			if err != nil {
				t.Fatalf("Apply: %v", err)
			}

			if string(body.Marshal()) != original {
				t.Fatalf("Apply mutated the input body: before=%s after=%s", original, body.Marshal())
			}

			gotBody := string(got.Marshal())
			if gotBody != c.ExpectedBody {
				t.Fatalf("body mismatch\n got: %s\nwant: %s", gotBody, c.ExpectedBody)
			}

			gotResults, err := json.Marshal(opResults)
			if err != nil {
				t.Fatalf("marshal opResults: %v", err)
			}
			if !jsonEqual(t, gotResults, c.ExpectedOpResults) {
				t.Fatalf("opResults mismatch\n got: %s\nwant: %s", gotResults, c.ExpectedOpResults)
			}
		})
	}
}

func jsonEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var av, bv interface{}
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatalf("unmarshal a: %v", err)
	}
	if len(b) == 0 {
		b = json.RawMessage("{}")
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("unmarshal b: %v", err)
	}
	ab, _ := json.Marshal(av)
	bb, _ := json.Marshal(bv)
	return string(ab) == string(bb)
}

func TestApplyUnknownOpErrors(t *testing.T) {
	body, _ := ojson.Parse([]byte(`{}`), 0)
	_, _, err := Apply(body, []contract.BodyOp{{Op: "not_a_real_op"}})
	if err == nil {
		t.Fatal("expected error for unknown op")
	}
}

func TestApplyDisallowedKeyErrors(t *testing.T) {
	body, _ := ojson.Parse([]byte(`{}`), 0)
	_, _, err := Apply(body, []contract.BodyOp{{Op: contract.OpSetTopLevel, Key: "stream", Value: json.RawMessage("true")}})
	if err == nil {
		t.Fatal("expected error for disallowed set_top_level key (stream is not mutable)")
	}
	_, _, err = Apply(body, []contract.BodyOp{{Op: contract.OpDeleteTopLevel, Key: "reasoning"}})
	if err == nil {
		t.Fatal("expected error for disallowed delete_top_level key (reasoning is not mutable)")
	}
}
