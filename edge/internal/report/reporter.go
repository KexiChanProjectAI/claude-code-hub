// Package report delivers completion reports and heartbeats to the control plane.
package report

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/contract"
	"github.com/ding113/claude-code-hub/edge/internal/control"
)

var retryDelays = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}

type Reporter struct {
	client *control.Client
	outbox *Outbox
	logger *slog.Logger
	wg     sync.WaitGroup
	// sleep is replaceable in tests.
	sleep func(context.Context, time.Duration) bool
}

func NewReporter(client *control.Client, outbox *Outbox, logger *slog.Logger) *Reporter {
	return &Reporter{client: client, outbox: outbox, logger: logger, sleep: sleepCtx}
}

func sleepCtx(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// Complete delivers the report in the background: retries with backoff, then spools
// it to the outbox. ctx bounds the retry phase (process shutdown).
func (r *Reporter) Complete(ctx context.Context, request *contract.CompleteRequest) {
	body, err := json.Marshal(request)
	if err != nil {
		r.logger.Error("failed to encode completion report", "requestId", request.RequestID, "error", err)
		return
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.deliver(ctx, request.RequestID, body)
	}()
}

func (r *Reporter) deliver(ctx context.Context, requestID int64, body json.RawMessage) {
	for attempt := 0; ; attempt++ {
		err := r.client.CompleteRaw(context.WithoutCancel(ctx), body)
		if err == nil {
			return
		}
		if control.IsStale(err) {
			r.logger.Warn("completion report rejected as stale", "requestId", requestID, "error", err)
			return
		}
		if attempt >= len(retryDelays) || !r.sleep(ctx, retryDelays[attempt]) {
			break
		}
	}
	if r.outbox == nil {
		r.logger.Error("completion report lost: control plane unreachable and no outbox", "requestId", requestID)
		return
	}
	if err := r.outbox.Append(body); err != nil {
		r.logger.Error("failed to spool completion report", "requestId", requestID, "error", err)
		return
	}
	r.logger.Warn("completion report spooled to outbox", "requestId", requestID)
}

// DrainOutbox replays spooled reports; stale rejections are dropped.
func (r *Reporter) DrainOutbox(ctx context.Context) (int, error) {
	if r.outbox == nil {
		return 0, nil
	}
	return r.outbox.Drain(func(line json.RawMessage) error {
		err := r.client.CompleteRaw(ctx, line)
		if err != nil && control.IsStale(err) {
			return ErrDrop
		}
		return err
	})
}

// RunOutboxDrainer drains the outbox periodically until ctx is done.
func (r *Reporter) RunOutboxDrainer(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if delivered, err := r.DrainOutbox(ctx); delivered > 0 || err != nil {
			r.logger.Info("outbox drain", "delivered", delivered, "error", errString(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Wait blocks until in-flight deliveries have finished or been spooled.
func (r *Reporter) Wait() { r.wg.Wait() }

// Heartbeat sends one heartbeat; failures are logged at debug level only.
func (r *Reporter) Heartbeat(ctx context.Context, request *contract.HeartbeatRequest) error {
	err := r.client.Heartbeat(ctx, request)
	if err != nil {
		r.logger.Debug("heartbeat failed", "requestId", request.RequestID, "error", err)
	}
	return err
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
