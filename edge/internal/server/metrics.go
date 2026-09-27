package server

import (
	"expvar"
	"sync"
	"time"
)

// Metrics are exported as JSON on /-/edge/metrics (expvar format).
type Metrics struct {
	requests       *expvar.Map
	attempts       *expvar.Map
	upstreamErrors *expvar.Map
	decideCalls    *expvar.Map
	decideLatency  *expvar.Float
	inflight       *expvar.Int
	bytesToClient  *expvar.Int
}

var (
	metricsOnce sync.Once
	sharedStats *Metrics
)

func newMap(name string) *expvar.Map {
	if existing := expvar.Get(name); existing != nil {
		if typed, ok := existing.(*expvar.Map); ok {
			return typed
		}
	}
	return expvar.NewMap(name)
}

// NewMetrics returns the process-wide metrics registry.
func NewMetrics() *Metrics {
	metricsOnce.Do(func() {
		sharedStats = &Metrics{
			requests:       newMap("edge_requests"),
			attempts:       newMap("edge_attempts"),
			upstreamErrors: newMap("edge_upstream_errors"),
			decideCalls:    newMap("edge_decide_calls"),
			decideLatency:  expvar.NewFloat("edge_decide_last_latency_ms"),
			inflight:       expvar.NewInt("edge_inflight"),
			bytesToClient:  expvar.NewInt("edge_bytes_to_client"),
		}
	})
	return sharedStats
}

func (m *Metrics) observeDecide(latency time.Duration, err error) {
	m.decideLatency.Set(float64(latency.Microseconds()) / 1000)
	if err != nil {
		m.decideCalls.Add("error", 1)
		return
	}
	m.decideCalls.Add("ok", 1)
}
