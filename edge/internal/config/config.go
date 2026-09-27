// Package config loads the edge executor configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string
	ControlURL   *url.URL
	DelegateURL  *url.URL
	SharedSecret string
	EdgeID       string

	OutboxDir      string
	OutboxMaxBytes int64

	MaxBodyBytes           int64
	MaxCompressedBodyBytes int64
	MaxJSONDepth           int
	MaxConcurrency         int
	OverflowToDelegate     bool
	FallbackToDelegate     bool

	DecideTimeout    time.Duration
	NextTimeout      time.Duration
	CompleteTimeout  time.Duration
	HeartbeatTimeout time.Duration

	GatePrebufferBytes int64
	ShutdownGrace      time.Duration
	TrustedProxyCIDRs  []string
	LogLevel           string
}

func env(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func envInt64(name string, fallback int64) (int64, error) {
	raw := env(name, "")
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	return value, nil
}

func envBool(name string, fallback bool) (bool, error) {
	raw := env(name, "")
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", name, err)
	}
	return value, nil
}

func envDurationMs(name string, fallback time.Duration) (time.Duration, error) {
	ms, err := envInt64(name, fallback.Milliseconds())
	if err != nil {
		return 0, err
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func parseBaseURL(name, raw string) (*url.URL, error) {
	if raw == "" {
		return nil, fmt.Errorf("%s is required", name)
	}
	parsed, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be an absolute URL", name)
	}
	return parsed, nil
}

// Load reads and validates the configuration.
func Load() (*Config, error) {
	var errs []error
	collect := func(err error) {
		if err != nil {
			errs = append(errs, err)
		}
	}

	cfg := &Config{
		ListenAddr: env("EDGE_LISTEN_ADDR", ":13580"),
		OutboxDir:  env("EDGE_OUTBOX_DIR", "/var/lib/cch-edge/outbox"),
		LogLevel:   env("EDGE_LOG_LEVEL", "info"),
	}

	controlURL, err := parseBaseURL("EDGE_CONTROL_URL", env("EDGE_CONTROL_URL", ""))
	collect(err)
	cfg.ControlURL = controlURL
	delegateURL, err := parseBaseURL("EDGE_DELEGATE_URL", env("EDGE_DELEGATE_URL", env("EDGE_CONTROL_URL", "")))
	collect(err)
	cfg.DelegateURL = delegateURL

	cfg.SharedSecret = env("EDGE_SHARED_SECRET", env("CCH_EDGE_SHARED_SECRET", ""))
	if len(cfg.SharedSecret) < 32 {
		collect(errors.New("EDGE_SHARED_SECRET must be at least 32 characters"))
	}

	hostname, _ := os.Hostname()
	cfg.EdgeID = env("EDGE_ID", hostname)
	if cfg.EdgeID == "" {
		cfg.EdgeID = "edge"
	}

	cfg.OutboxMaxBytes, err = envInt64("EDGE_OUTBOX_MAX_BYTES", 1<<30)
	collect(err)
	cfg.MaxBodyBytes, err = envInt64("EDGE_MAX_BODY_BYTES", 100<<20)
	collect(err)
	cfg.MaxCompressedBodyBytes, err = envInt64("EDGE_MAX_COMPRESSED_BODY_BYTES", cfg.MaxBodyBytes)
	collect(err)
	depth, err := envInt64("EDGE_MAX_JSON_DEPTH", 512)
	collect(err)
	cfg.MaxJSONDepth = int(depth)
	concurrency, err := envInt64("EDGE_MAX_CONCURRENCY", 1024)
	collect(err)
	cfg.MaxConcurrency = int(concurrency)
	cfg.OverflowToDelegate, err = envBool("EDGE_OVERFLOW_TO_DELEGATE", true)
	collect(err)
	cfg.FallbackToDelegate, err = envBool("EDGE_FALLBACK_TO_DELEGATE", true)
	collect(err)

	cfg.DecideTimeout, err = envDurationMs("EDGE_DECIDE_TIMEOUT_MS", 5*time.Second)
	collect(err)
	cfg.NextTimeout, err = envDurationMs("EDGE_NEXT_TIMEOUT_MS", 5*time.Second)
	collect(err)
	cfg.CompleteTimeout, err = envDurationMs("EDGE_COMPLETE_TIMEOUT_MS", 15*time.Second)
	collect(err)
	cfg.HeartbeatTimeout, err = envDurationMs("EDGE_HEARTBEAT_TIMEOUT_MS", 5*time.Second)
	collect(err)
	cfg.GatePrebufferBytes, err = envInt64("EDGE_GATE_GLOBAL_PREBUFFER_BYTES", 256<<20)
	collect(err)
	cfg.ShutdownGrace, err = envDurationMs("EDGE_SHUTDOWN_GRACE_MS", 120*time.Second)
	collect(err)

	if raw := env("EDGE_TRUSTED_PROXY_CIDRS", ""); raw != "" {
		for _, part := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				cfg.TrustedProxyCIDRs = append(cfg.TrustedProxyCIDRs, trimmed)
			}
		}
	}

	if cfg.MaxConcurrency < 1 {
		collect(errors.New("EDGE_MAX_CONCURRENCY must be positive"))
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return cfg, nil
}
