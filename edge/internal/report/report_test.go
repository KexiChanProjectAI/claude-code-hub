package report

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/control"
)

func TestOutboxAppendDrainAndPartialFailure(t *testing.T) {
	outbox, err := NewOutbox(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{`{"a":1}`, `{"a":2}`, `{"a":3}`} {
		if err := outbox.Append([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if outbox.PendingBytes() == 0 {
		t.Fatal("expected pending bytes")
	}
	if err := outbox.Append([]byte("a\nb")); err == nil {
		t.Fatal("multi-line reports must be rejected")
	}

	var seen []string
	delivered, err := outbox.Drain(func(line json.RawMessage) error {
		seen = append(seen, string(line))
		if string(line) == `{"a":2}` {
			return errors.New("down")
		}
		return nil
	})
	if err == nil || delivered != 1 {
		t.Fatalf("expected partial drain, got %d %v", delivered, err)
	}
	delivered, err = outbox.Drain(func(line json.RawMessage) error {
		seen = append(seen, string(line))
		if string(line) == `{"a":3}` {
			return ErrDrop
		}
		return nil
	})
	if err != nil || delivered != 2 {
		t.Fatalf("second drain: %d %v", delivered, err)
	}
	if outbox.PendingBytes() != 0 {
		t.Fatal("outbox should be empty")
	}
	want := []string{`{"a":1}`, `{"a":2}`, `{"a":2}`, `{"a":3}`}
	if len(seen) != len(want) {
		t.Fatalf("seen %v", seen)
	}
	for index := range want {
		if seen[index] != want[index] {
			t.Fatalf("seen %v", seen)
		}
	}
}

func TestOutboxBudgetDropsOldestFiles(t *testing.T) {
	dir := t.TempDir()
	outbox, _ := NewOutbox(dir, 10)
	_ = outbox.Append([]byte(`{"first":true}`))
	outbox.current = "" // force a new file
	time.Sleep(time.Millisecond)
	_ = outbox.Append([]byte(`{"second":true}`))
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected oldest file dropped, have %d files", len(entries))
	}
	data, _ := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if string(data) != "{\"second\":true}\n" {
		t.Fatalf("unexpected surviving content %q", data)
	}
}

type recorder struct {
	mu       sync.Mutex
	statuses []int
	bodies   []string
	calls    atomic.Int32
}

func controlServer(t *testing.T, rec *recorder) (*control.Client, func()) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		index := int(rec.calls.Add(1)) - 1
		rec.mu.Lock()
		rec.bodies = append(rec.bodies, string(body))
		status := http.StatusOK
		if index < len(rec.statuses) {
			status = rec.statuses[index]
		}
		rec.mu.Unlock()
		w.WriteHeader(status)
		if status == http.StatusConflict {
			_, _ = w.Write([]byte(`{"error":{"code":"stale_step","message":"stale_step"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	base, _ := url.Parse(srv.URL)
	return control.New(control.Options{BaseURL: base, Secret: "s", EdgeID: "e", CompleteTimeout: time.Second}), srv.Close
}

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestReporterRetriesThenSucceeds(t *testing.T) {
	rec := &recorder{statuses: []int{500, 502, 200}}
	client, closeServer := controlServer(t, rec)
	defer closeServer()
	reporter := NewReporter(client, nil, testLogger())
	reporter.sleep = func(context.Context, time.Duration) bool { return true }
	reporter.Complete(context.Background(), &contract.CompleteRequest{RequestID: 5, EdgeToken: "t", Losers: []contract.LoserResult{}})
	reporter.Wait()
	if rec.calls.Load() != 3 {
		t.Fatalf("expected 3 attempts, got %d", rec.calls.Load())
	}
}

func TestReporterSpoolsAfterRetriesAndDrainsLater(t *testing.T) {
	rec := &recorder{statuses: []int{500, 500, 500, 500, 500, 500}}
	client, closeServer := controlServer(t, rec)
	defer closeServer()
	outbox, _ := NewOutbox(t.TempDir(), 1<<20)
	reporter := NewReporter(client, outbox, testLogger())
	reporter.sleep = func(context.Context, time.Duration) bool { return true }
	reporter.Complete(context.Background(), &contract.CompleteRequest{RequestID: 6, EdgeToken: "t", Losers: []contract.LoserResult{}})
	reporter.Wait()
	if outbox.PendingBytes() == 0 {
		t.Fatal("report should be spooled")
	}
	delivered, err := reporter.DrainOutbox(context.Background())
	if err != nil || delivered != 1 {
		t.Fatalf("drain: %d %v", delivered, err)
	}
	var sent contract.CompleteRequest
	_ = json.Unmarshal([]byte(rec.bodies[len(rec.bodies)-1]), &sent)
	if sent.RequestID != 6 {
		t.Fatalf("unexpected replayed body %s", rec.bodies[len(rec.bodies)-1])
	}
}

func TestReporterDropsStaleReports(t *testing.T) {
	rec := &recorder{statuses: []int{409}}
	client, closeServer := controlServer(t, rec)
	defer closeServer()
	outbox, _ := NewOutbox(t.TempDir(), 1<<20)
	reporter := NewReporter(client, outbox, testLogger())
	reporter.Complete(context.Background(), &contract.CompleteRequest{RequestID: 7, EdgeToken: "t", Losers: []contract.LoserResult{}})
	reporter.Wait()
	if rec.calls.Load() != 1 || outbox.PendingBytes() != 0 {
		t.Fatalf("stale report must not be retried or spooled: calls=%d", rec.calls.Load())
	}
}
