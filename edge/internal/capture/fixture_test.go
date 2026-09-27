package capture

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func loadFixture(t *testing.T, name string, out interface{}) {
	t.Helper()
	path := "../../../tests/fixtures/edge/capture/" + name
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatalf("unmarshal fixture %s: %v", path, err)
	}
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	return b
}
