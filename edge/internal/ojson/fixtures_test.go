package ojson

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

const fixtureDir = "../../../tests/fixtures/edge/body"

func readFixture(t *testing.T, name string, v interface{}) {
	t.Helper()
	data, err := os.ReadFile(fixtureDir + "/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("unmarshal fixture %s: %v", name, err)
	}
}

type stableCase struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Expected string `json:"expected"`
}

func TestStableStringifyFixtures(t *testing.T) {
	var cases []stableCase
	readFixture(t, "stable-stringify.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			v, err := Parse([]byte(c.Value), 0)
			if err != nil {
				t.Fatalf("parse input: %v", err)
			}
			got := StableStringify(v)
			if got != c.Expected {
				t.Fatalf("StableStringify mismatch\n got: %s\nwant: %s", got, c.Expected)
			}
		})
	}
}

type jsNumberCase struct {
	Literal  string `json:"literal"`
	Expected string `json:"expected"`
}

func TestFormatJSNumberFixtures(t *testing.T) {
	var cases []jsNumberCase
	readFixture(t, "js-number.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}
	for _, c := range cases {
		t.Run(c.Literal, func(t *testing.T) {
			f, err := strconv.ParseFloat(c.Literal, 64)
			if err != nil {
				t.Fatalf("parse literal %q: %v", c.Literal, err)
			}
			got := FormatJSNumber(f)
			if got != c.Expected {
				t.Fatalf("FormatJSNumber(%s) = %s, want %s", c.Literal, got, c.Expected)
			}
		})
	}
}
