package snapshot

import (
	"encoding/json"
	"testing"
)

func TestSemanticIgnoresNumericAndTimestampFormatting(t *testing.T) {
	left := []map[string]any{{
		"price": json.Number("1.0"), "at": "2026-10-05T00:00:00+08:00", "name": "a",
	}}
	right := []map[string]any{{
		"name": "a", "at": "2026-10-04T16:00:00Z", "price": json.Number("1"),
	}}
	a, err := Semantic(left)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Semantic(right)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("semantic mismatch %s %s", a, b)
	}
}

func TestDigestChangesWhenRowChanges(t *testing.T) {
	schema := []Column{{Table: "providers", Name: "name", Type: "text"}}
	first, err := Digest(schema, map[string][]map[string]any{
		"providers": {{"id": json.Number("1"), "name": "a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Digest(schema, map[string][]map[string]any{
		"providers": {{"name": "b", "id": json.Number("1")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("digest ignored a value change")
	}
	repeated, err := Digest(schema, map[string][]map[string]any{
		"providers": {{"name": "a", "id": json.Number("1")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first != repeated {
		t.Fatal("digest depends on key order")
	}
}

func TestWireDigestMatchesMapDigest(t *testing.T) {
	schema := []Column{{Table: "providers", Name: "name", Type: "text"}}
	tables := map[string][]map[string]any{
		"providers": {{"id": json.Number("1"), "name": "b"}, {"name": "a", "id": json.Number("2")}},
	}
	want, err := Digest(schema, tables)
	if err != nil {
		t.Fatal(err)
	}
	assembler, err := NewAssembler(schema, []string{"providers"})
	if err != nil {
		t.Fatal(err)
	}
	if err = assembler.BeginTable("providers"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"name":"b","id":1}`, `{"id":2,"name":"a"}`} {
		if err = assembler.WriteRow(raw); err != nil {
			t.Fatal(err)
		}
	}
	if err = assembler.EndTable(); err != nil {
		t.Fatal(err)
	}
	wire, err := assembler.Finish()
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyWire(wire)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("wire digest %s want %s body %s", got, want, wire)
	}
}
