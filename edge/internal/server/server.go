package server

import (
	"context"
	"expvar"
	"net/http"
	"sync/atomic"
	"time"
)

const (
	healthPath  = "/-/edge/healthz"
	readyPath   = "/-/edge/readyz"
	metricsPath = "/-/edge/metrics"
)

// ReadinessProbe reports whether the edge should receive traffic.
type ReadinessProbe struct {
	ready          atomic.Bool
	draining       atomic.Bool
	lastControlOK  atomic.Int64
	outboxBytes    func() int64
	outboxMaxReady int64
}

func NewReadinessProbe(outboxBytes func() int64, outboxMaxReady int64) *ReadinessProbe {
	return &ReadinessProbe{outboxBytes: outboxBytes, outboxMaxReady: outboxMaxReady}
}

func (p *ReadinessProbe) MarkControlOK() {
	p.lastControlOK.Store(time.Now().UnixMilli())
	p.ready.Store(true)
}
func (p *ReadinessProbe) MarkDraining()    { p.draining.Store(true) }
func (p *ReadinessProbe) IsDraining() bool { return p.draining.Load() }

func (p *ReadinessProbe) isReady() bool {
	if p.draining.Load() || !p.ready.Load() {
		return false
	}
	if time.Since(time.UnixMilli(p.lastControlOK.Load())) > time.Minute {
		return false
	}
	if p.outboxBytes != nil && p.outboxMaxReady > 0 && p.outboxBytes() > p.outboxMaxReady {
		return false
	}
	return true
}

// Mux routes operational endpoints and hands everything else to the proxy handler.
func Mux(handler http.Handler, probe *ReadinessProbe) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc(readyPath, func(w http.ResponseWriter, _ *http.Request) {
		if probe.isReady() {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ready"))
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready"))
	})
	mux.Handle(metricsPath, expvar.Handler())
	mux.Handle("/", handler)
	return mux
}

// RunControlProbe keeps readiness in sync with control-plane reachability.
func RunControlProbe(ctx context.Context, probe *ReadinessProbe, check func(context.Context) error, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if check(checkCtx) == nil {
			probe.MarkControlOK()
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
