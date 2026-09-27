package ojson

import "testing"

func TestParseMarshalRoundTripPreservesLiterals(t *testing.T) {
	input := `{"b":1,"a":2.50000000000000000,"c":1e21,"nested":{"z":1,"y":2}}`
	v, err := Parse([]byte(input), 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := string(v.Marshal())
	if got != input {
		t.Fatalf("marshal mismatch\n got: %s\nwant: %s", got, input)
	}
}

func TestParseDuplicateKeysLastValueFirstPosition(t *testing.T) {
	v, err := Parse([]byte(`{"a":1,"b":2,"a":3}`), 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	keys := v.ObjectKeys()
	if len(keys) != 2 || keys[0] != "a" || keys[1] != "b" {
		t.Fatalf("unexpected key order: %v", keys)
	}
	val, ok := v.ObjectGet("a")
	if !ok || val.Number() != "3" {
		t.Fatalf("expected a=3, got %v", val)
	}
	if string(v.Marshal()) != `{"a":3,"b":2}` {
		t.Fatalf("unexpected marshal: %s", v.Marshal())
	}
}

func TestObjectSetKeepsPositionOnExistingKey(t *testing.T) {
	v, _ := Parse([]byte(`{"a":1,"b":2,"c":3}`), 0)
	v.ObjectSet("b", NewNumberLiteral("99"))
	if string(v.Marshal()) != `{"a":1,"b":99,"c":3}` {
		t.Fatalf("unexpected marshal: %s", v.Marshal())
	}
	v.ObjectSet("d", NewNumberLiteral("4"))
	if string(v.Marshal()) != `{"a":1,"b":99,"c":3,"d":4}` {
		t.Fatalf("unexpected marshal after append: %s", v.Marshal())
	}
	v.ObjectDelete("a")
	if string(v.Marshal()) != `{"b":99,"c":3,"d":4}` {
		t.Fatalf("unexpected marshal after delete: %s", v.Marshal())
	}
}

func TestCloneIsIndependent(t *testing.T) {
	v, _ := Parse([]byte(`{"a":[1,2,{"x":1}]}`), 0)
	clone := v.Clone()
	arr, _ := v.ObjectGet("a")
	arr.ArrayAppend(NewNumberLiteral("3"))
	cloneArr, _ := clone.ObjectGet("a")
	if cloneArr.ArrayLen() != 3 {
		t.Fatalf("expected clone array to stay at 3 items, got %d", cloneArr.ArrayLen())
	}
}

func TestParseDepthLimit(t *testing.T) {
	nested := ""
	for i := 0; i < 20; i++ {
		nested += `{"a":`
	}
	nested += "1"
	for i := 0; i < 20; i++ {
		nested += "}"
	}
	if _, err := Parse([]byte(nested), 5); err == nil {
		t.Fatal("expected depth-limit error")
	}
	if _, err := Parse([]byte(nested), 50); err != nil {
		t.Fatalf("expected success with generous depth limit: %v", err)
	}
}

func TestMarshalStringEscaping(t *testing.T) {
	v := NewString("a\"b\\c\nd\te<f>g&h\x01i")
	got := string(v.Marshal())
	want := `"a\"b\\c\nd\te<f>g&h\u0001i"`
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestMarshalUnicodeNotEscaped(t *testing.T) {
	v := NewString("中文\U0001F600")
	got := string(v.Marshal())
	want := "\"中文\U0001F600\""
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
