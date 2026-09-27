package gate

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrLocalCapacity is returned when a Budget cannot grant a reservation
// because the process-wide prebuffer budget is exhausted and the caller has
// waited past the queue depth or wait timeout.
//
// This is a simplified, single-tier stand-in for the TypeScript
// StreamGatePrebufferBudget (prebuffer-budget.ts), which layers a local
// queue on top of a shared MemoryGovernor lease. Go's Budget only implements
// the local layer: a process-wide byte ceiling with FIFO waiting.
var ErrLocalCapacity = errors.New("gate: local prebuffer capacity exhausted")

// defaultAcquireTimeout bounds how long Acquire waits in its FIFO queue when
// ctx carries no deadline, mirroring the TS budget's 20s default.
const defaultAcquireTimeout = 20 * time.Second

// maxQueueDepth bounds the number of waiters queued behind the budget,
// mirroring the TS budget's waitingCount >= 1024 rejection.
const maxQueueDepth = 1024

// Budget is a process-wide shared byte budget for stream-gate prebuffering.
// It is safe for concurrent use.
type Budget struct {
	mu       sync.Mutex
	limit    int64
	reserved int64
	waiters  []*waiter
}

type waiter struct {
	bytes int64
	ch    chan struct{}
}

// NewBudget creates a Budget with the given byte ceiling. limitBytes <= 0
// means unlimited (Acquire never blocks or fails for capacity reasons).
func NewBudget(limitBytes int64) *Budget {
	return &Budget{limit: limitBytes}
}

// Lease represents a granted, growable/shrinkable reservation against a
// Budget. It is safe for concurrent use.
type Lease struct {
	b        *Budget
	mu       sync.Mutex
	bytes    int64
	released bool
}

// Acquire reserves bytes from the budget, waiting (FIFO, honoring ctx) if
// the budget is currently full. It returns ErrLocalCapacity if the queue is
// full or the wait exceeds its timeout, or ctx.Err() if ctx is cancelled
// first.
func (b *Budget) Acquire(ctx context.Context, bytes int64) (*Lease, error) {
	if bytes <= 0 {
		return nil, fmt.Errorf("gate: budget reservation must be positive, got %d", bytes)
	}
	if b.limit > 0 && bytes > b.limit {
		return nil, fmt.Errorf("gate: reservation %d exceeds budget limit %d", bytes, b.limit)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	b.mu.Lock()
	if b.limit <= 0 || (len(b.waiters) == 0 && b.reserved+bytes <= b.limit) {
		b.reserved += bytes
		b.mu.Unlock()
		return &Lease{b: b, bytes: bytes}, nil
	}
	if len(b.waiters) >= maxQueueDepth {
		b.mu.Unlock()
		return nil, ErrLocalCapacity
	}
	w := &waiter{bytes: bytes, ch: make(chan struct{})}
	b.waiters = append(b.waiters, w)
	b.mu.Unlock()

	timeout := defaultAcquireTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < timeout {
			timeout = remaining
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-w.ch:
		return &Lease{b: b, bytes: bytes}, nil
	case <-ctx.Done():
		if b.removeWaiter(w) {
			return nil, ctx.Err()
		}
		// Lost the race with drain(): the waiter was already granted.
		<-w.ch
		return &Lease{b: b, bytes: bytes}, nil
	case <-timer.C:
		if b.removeWaiter(w) {
			return nil, ErrLocalCapacity
		}
		<-w.ch
		return &Lease{b: b, bytes: bytes}, nil
	}
}

func (b *Budget) removeWaiter(w *waiter) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, x := range b.waiters {
		if x == w {
			b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
			return true
		}
	}
	return false
}

// drain grants queued waiters in strict FIFO order: a waiter that does not
// currently fit blocks the whole queue behind it (matching the TS budget,
// which does not let smaller later waiters jump ahead).
func (b *Budget) drain() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for len(b.waiters) > 0 {
		head := b.waiters[0]
		if b.limit > 0 && b.reserved+head.bytes > b.limit {
			return
		}
		b.reserved += head.bytes
		b.waiters = b.waiters[1:]
		close(head.ch)
	}
}

// ReservedBytes returns the lease's currently reserved size.
func (l *Lease) ReservedBytes() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.bytes
}

// Grow attempts to grow the lease to bytes total (a no-op, returning true,
// if bytes <= current size). It fails without blocking if the budget has no
// room.
func (l *Lease) Grow(bytes int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return false
	}
	if bytes <= l.bytes {
		return true
	}
	delta := bytes - l.bytes
	l.b.mu.Lock()
	if l.b.limit > 0 && l.b.reserved+delta > l.b.limit {
		l.b.mu.Unlock()
		return false
	}
	l.b.reserved += delta
	l.b.mu.Unlock()
	l.bytes = bytes
	return true
}

// ShrinkTo reduces the lease to bytes total, releasing the difference back
// to the budget and waking any waiters it can now satisfy. It is a no-op if
// bytes >= the current size.
func (l *Lease) ShrinkTo(bytes int64) {
	l.mu.Lock()
	if l.released || bytes >= l.bytes {
		l.mu.Unlock()
		return
	}
	delta := l.bytes - bytes
	l.bytes = bytes
	l.mu.Unlock()

	l.b.mu.Lock()
	l.b.reserved -= delta
	l.b.mu.Unlock()
	l.b.drain()
}

// Release returns the lease's entire reservation to the budget. It is
// idempotent.
func (l *Lease) Release() {
	l.mu.Lock()
	if l.released {
		l.mu.Unlock()
		return
	}
	l.released = true
	bytes := l.bytes
	l.bytes = 0
	l.mu.Unlock()

	l.b.mu.Lock()
	l.b.reserved -= bytes
	l.b.mu.Unlock()
	l.b.drain()
}

// Snapshot reports the budget's current reservation and queue depth
// (primarily for tests/diagnostics).
func (b *Budget) Snapshot() (reservedBytes int64, waiting int, limit int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.reserved, len(b.waiters), b.limit
}
