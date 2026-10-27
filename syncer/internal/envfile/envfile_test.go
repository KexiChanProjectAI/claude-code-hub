package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "env")
	content := "# comment\nexport DSN=\"postgresql://user:pa\\\"ss@127.0.0.1/db\"\nREDIS_URL='redis://127.0.0.1:6379'\n\nNO_VALUE\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if values["DSN"] != `postgresql://user:pa"ss@127.0.0.1/db` {
		t.Fatalf("dsn = %q", values["DSN"])
	}
	if values["REDIS_URL"] != "redis://127.0.0.1:6379" {
		t.Fatalf("redis = %q", values["REDIS_URL"])
	}
	if _, ok := values["NO_VALUE"]; ok {
		t.Fatal("line without equals was loaded")
	}
}
