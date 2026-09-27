// Command edge runs the CCH edge executor: it fronts client traffic, executes
// eligible Anthropic /v1/messages upstream calls under the control plane's
// direction and reverse-proxies everything else to the control plane.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ding113/claude-code-hub/edge/internal/config"
	"github.com/ding113/claude-code-hub/edge/internal/control"
	"github.com/ding113/claude-code-hub/edge/internal/delegate"
	"github.com/ding113/claude-code-hub/edge/internal/gate"
	"github.com/ding113/claude-code-hub/edge/internal/report"
	"github.com/ding113/claude-code-hub/edge/internal/server"
	"github.com/ding113/claude-code-hub/edge/internal/upstream"
)

var version = "dev"

func newLogger(level string) *slog.Logger {
	var slogLevel slog.Level
	switch strings.ToLower(level) {
	case "debug":
		slogLevel = slog.LevelDebug
	case "warn":
		slogLevel = slog.LevelWarn
	case "error":
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slogLevel}))
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	logger := newLogger(cfg.LogLevel).With("edgeId", cfg.EdgeID)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	backgroundCtx, cancelBackground := context.WithCancel(context.Background())
	defer cancelBackground()

	client := control.New(control.Options{
		BaseURL:          cfg.ControlURL,
		Secret:           cfg.SharedSecret,
		EdgeID:           cfg.EdgeID,
		DecideTimeout:    cfg.DecideTimeout,
		NextTimeout:      cfg.NextTimeout,
		CompleteTimeout:  cfg.CompleteTimeout,
		HeartbeatTimeout: cfg.HeartbeatTimeout,
	})
	outbox, err := report.NewOutbox(cfg.OutboxDir, cfg.OutboxMaxBytes)
	if err != nil {
		logger.Error("outbox unavailable, completion reports will not be spooled", "dir", cfg.OutboxDir, "error", err)
		outbox = nil
	}
	reporter := report.NewReporter(client, outbox, logger)

	handler := server.NewHandler(server.Deps{
		Config:    cfg,
		Control:   client,
		Reporter:  reporter,
		Delegator: delegate.New(cfg.DelegateURL, logger),
		Upstream:  upstream.NewClient(),
		Budget:    gate.NewBudget(cfg.GatePrebufferBytes),
		Logger:    logger,
		BaseCtx:   backgroundCtx,
	})

	outboxBytes := func() int64 { return 0 }
	if outbox != nil {
		outboxBytes = outbox.PendingBytes
	}
	probe := server.NewReadinessProbe(outboxBytes, cfg.OutboxMaxBytes/2)
	go server.RunControlProbe(backgroundCtx, probe, client.Health, 15*time.Second)
	go reporter.RunOutboxDrainer(backgroundCtx, 5*time.Second)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.Mux(handler, probe),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("edge executor listening", "addr", cfg.ListenAddr, "version", version,
			"control", cfg.ControlURL.Redacted(), "delegate", cfg.DelegateURL.Redacted())
		serveErr <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
	}

	logger.Info("shutting down: draining in-flight requests", "grace", cfg.ShutdownGrace.String())
	probe.MarkDraining()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("graceful shutdown incomplete", "error", err)
	}
	reporter.Wait()
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelDrain()
	if delivered, err := reporter.DrainOutbox(drainCtx); delivered > 0 || err != nil {
		logger.Info("final outbox drain", "delivered", delivered, "error", err)
	}
	cancelBackground()
	logger.Info("edge executor stopped")
}
