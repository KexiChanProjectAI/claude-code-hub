package digest

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/ojson"
)

const fixtureDir = "../../../tests/fixtures/edge/body"

type digestCase struct {
	Name     string          `json:"name"`
	Body     string          `json:"body"`
	Path     string          `json:"path"`
	Method   string          `json:"method"`
	Headers  [][2]string     `json:"headers"`
	ClientIP *string         `json:"clientIp"`
	Expected json.RawMessage `json:"expected"`
}

func TestBuildFixtures(t *testing.T) {
	data, err := os.ReadFile(fixtureDir + "/digest.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []digestCase
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

			var expected map[string]json.RawMessage
			if err := json.Unmarshal(c.Expected, &expected); err != nil {
				t.Fatalf("unmarshal expected: %v", err)
			}

			method := c.Method
			if method == "" {
				method = "POST"
			}

			headers := make([]contract.HeaderPair, len(c.Headers))
			for i, h := range c.Headers {
				headers[i] = contract.HeaderPair{h[0], h[1]}
			}

			got := Build(Input{
				EdgeID:        "edge-fixture",
				EdgeRequestID: "req-fixture",
				ReceivedAtMs:  1_700_000_000_000,
				Method:        method,
				Path:          c.Path,
				Headers:       headers,
				ClientIP:      c.ClientIP,
				Body:          body,
				BodyBytes:     len(c.Body),
			})

			gotJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal got: %v", err)
			}
			var gotMap map[string]json.RawMessage
			if err := json.Unmarshal(gotJSON, &gotMap); err != nil {
				t.Fatalf("unmarshal got: %v", err)
			}
			// receivedAtMs/edgeId/edgeRequestId are excluded from the fixture.
			delete(gotMap, "receivedAtMs")
			delete(gotMap, "edgeId")
			delete(gotMap, "edgeRequestId")

			for key, wantRaw := range expected {
				gotRaw, ok := gotMap[key]
				if !ok {
					t.Fatalf("field %q missing from Build() output", key)
				}
				if !canonicalJSONEqual(t, gotRaw, wantRaw) {
					t.Fatalf("field %q mismatch\n got: %s\nwant: %s", key, gotRaw, wantRaw)
				}
			}
		})
	}
}

// canonicalJSONEqual compares two JSON fragments by structural equality after
// decoding into `any` (numbers become float64 on both sides, matching how the
// TS reference's own JSON.parse/JSON.stringify round-trip normalizes them).
func canonicalJSONEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var av, bv interface{}
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatalf("unmarshal a: %v", err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("unmarshal b: %v", err)
	}
	return reflect.DeepEqual(av, bv)
}
