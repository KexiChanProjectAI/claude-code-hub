// Package source serves read-only configuration snapshots to the paired target.
package source

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ding113/claude-code-hub/syncer/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/klauspost/compress/zstd"
)

// Config is the source peer endpoint.
type Config struct {
	Listen   string
	DSN      string
	Token    string
	CertFile string
	KeyFile  string
}

// Run listens until the context is cancelled.
func Run(ctx context.Context, config Config) error {
	if config.Listen == "" || config.DSN == "" || config.Token == "" || config.CertFile == "" || config.KeyFile == "" {
		return errors.New("invalid_config")
	}
	certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
	if err != nil {
		return errors.New("invalid_tls")
	}
	service := &service{dsn: config.DSN}
	server := &http.Server{
		Addr:              config.Listen,
		Handler:           service.handler(config.Token),
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		WriteTimeout:      180 * time.Second,
	}
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return err
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("source listening", "addr", config.Listen)
		errCh <- server.Serve(tls.NewListener(listener, server.TLSConfig))
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

type service struct {
	dsn  string
	mu   sync.Mutex
	conn *pgx.Conn
}

func (s *service) handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/v1/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !authorized(r.Header.Get("Authorization"), token) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
		defer cancel()
		body, err := s.snapshot(ctx)
		if err != nil {
			slog.Error("snapshot failed", "code", codeOf(err))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"source_unavailable"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "zstd")
		w.Header().Set("Cache-Control", "no-store")
		encoder, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(1))
		if err != nil {
			return
		}
		if _, err = encoder.Write(body); err == nil {
			err = encoder.Close()
		} else {
			_ = encoder.Close()
		}
		if err != nil {
			slog.Error("snapshot compress failed", "code", codeOf(err))
		}
	})
	return mux
}

func (s *service) snapshot(ctx context.Context) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil || s.conn.IsClosed() {
		conn, err := db.Connect(ctx, s.dsn)
		if err != nil {
			return nil, err
		}
		s.conn = conn
	}
	body, err := db.ReadSnapshot(ctx, s.conn)
	if err != nil {
		_ = s.conn.Close(context.Background())
		s.conn = nil
		return nil, err
	}
	return body, nil
}

func authorized(got, token string) bool {
	want := "Bearer " + token
	if len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func codeOf(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if strings.Contains(text, " ") || strings.Contains(text, "@") || strings.Contains(text, "://") || len(text) > 80 {
		return "database_error"
	}
	return text
}

// LoadToken reads a single-line bearer token.
func LoadToken(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(body))
	if len(token) < 32 {
		return "", errors.New("invalid_token")
	}
	return token, nil
}
