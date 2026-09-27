package gate

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

// blockingReader never returns from Read until unblocked, then reports EOF.
type blockingReader struct {
	unblock chan struct{}
}

func newBlockingReader() *blockingReader {
	return &blockingReader{unblock: make(chan struct{})}
}

func (r *blockingReader) Read(p []byte) (int, error) {
	<-r.unblock
	return 0, io.EOF
}

func (r *blockingReader) Release() {
	close(r.unblock)
}

func TestRunIdleTimeout(t *testing.T) {
	r := newBlockingReader()
	defer r.Release() // unblock the leaked goroutine so the test process can exit cleanly

	res := Run(context.Background(), r, Options{
		Family:      FamilyAnthropic,
		EventCap:    64,
		ByteCap:     1024,
		IdleTimeout: 20 * time.Millisecond,
	})

	if res.Committed {
		t.Fatal("expected failure, got committed")
	}
	if res.Failure == nil || res.Failure.Reason != "idle_timeout" {
		t.Fatalf("expected idle_timeout failure, got %+v (readErr=%v)", res.Failure, res.ReadErr)
	}
}

func TestRunIdleTimeoutDoesNotFireWhileChunksArrive(t *testing.T) {
	// A reader that trickles bytes in well within the idle timeout should
	// commit normally rather than timing out.
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		frames := []string{
			"event: ping\ndata: {\"type\":\"ping\"}\n\n",
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n",
		}
		for _, f := range frames {
			_, _ = pw.Write([]byte(f))
			time.Sleep(5 * time.Millisecond)
		}
	}()

	res := Run(context.Background(), pr, Options{
		Family:      FamilyAnthropic,
		EventCap:    64,
		ByteCap:     4096,
		IdleTimeout: 200 * time.Millisecond,
	})
	if !res.Committed {
		t.Fatalf("expected commit, got failure=%+v readErr=%v", res.Failure, res.ReadErr)
	}
}

func TestRunContextCancellation(t *testing.T) {
	r := newBlockingReader()
	defer r.Release()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() {
		done <- Run(ctx, r, Options{Family: FamilyAnthropic, EventCap: 64, ByteCap: 1024})
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case res := <-done:
		if res.Committed {
			t.Fatal("expected failure, got committed")
		}
		if res.ReadErr == nil {
			t.Fatal("expected ReadErr to be set on ctx cancellation")
		}
		if !errors.Is(res.ReadErr, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", res.ReadErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after ctx cancellation")
	}
}

func TestRunOnFirstByteCalledOnce(t *testing.T) {
	body := "event: ping\ndata: {\"type\":\"ping\"}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n"
	r := newChunkedReader([]string{"e", "vent: ping\n", body[12:]})

	var calls int32
	res := Run(context.Background(), r, Options{
		Family:   FamilyAnthropic,
		EventCap: 64,
		ByteCap:  4096,
		OnFirstByte: func() {
			atomic.AddInt32(&calls, 1)
		},
	})
	if !res.Committed {
		t.Fatalf("expected commit, got failure=%+v", res.Failure)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("OnFirstByte called %d times, want 1", got)
	}
}

func TestRunBudgetExhaustionYieldsLocalCapacity(t *testing.T) {
	budget := NewBudget(1024)
	// Exhaust the budget with a held lease (limit is large enough for Run's
	// own reservation to be valid in principle -- it should queue, not be
	// rejected outright for exceeding the limit).
	held, err := budget.Acquire(context.Background(), 1024)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer held.Release()

	r := newChunkedReader([]string{"event: ping\ndata: {\"type\":\"ping\"}\n\n"})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	res := Run(ctx, r, Options{
		Family:   FamilyAnthropic,
		EventCap: 64,
		ByteCap:  256,
		Budget:   budget,
	})

	if res.Committed {
		t.Fatal("expected failure, got committed")
	}
	if res.Failure == nil || res.Failure.Reason != "local_capacity" {
		t.Fatalf("expected local_capacity failure, got failure=%+v readErr=%v", res.Failure, res.ReadErr)
	}
}

func TestRunBudgetGrantedAfterRelease(t *testing.T) {
	budget := NewBudget(4096)
	held, err := budget.Acquire(context.Background(), 4096)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	r := newChunkedReader([]string{
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n",
	})

	done := make(chan Result, 1)
	go func() {
		done <- Run(context.Background(), r, Options{
			Family:   FamilyAnthropic,
			EventCap: 64,
			ByteCap:  1024,
			Budget:   budget,
		})
	}()

	time.Sleep(20 * time.Millisecond)
	held.Release()

	select {
	case res := <-done:
		if !res.Committed {
			t.Fatalf("expected commit, got failure=%+v readErr=%v", res.Failure, res.ReadErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after budget release")
	}

	reserved, waiting, _ := budget.Snapshot()
	if reserved != 0 || waiting != 0 {
		t.Fatalf("expected budget fully released, got reserved=%d waiting=%d", reserved, waiting)
	}
}
