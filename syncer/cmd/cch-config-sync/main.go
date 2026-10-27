package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ding113/claude-code-hub/syncer/internal/envfile"
	"github.com/ding113/claude-code-hub/syncer/internal/source"
	"github.com/ding113/claude-code-hub/syncer/internal/target"
)

func main() {
	if len(os.Args) < 2 {
		slog.Error("usage: cch-config-sync source|target [--once] [--dry-run]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	once := flags.Bool("once", false, "run one target check and exit")
	dry := flags.Bool("dry-run", false, "plan the target sync without writing")
	if err := flags.Parse(os.Args[2:]); err != nil {
		os.Exit(2)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(flushWriter{os.Stdout}, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var err error
	switch os.Args[1] {
	case "source":
		err = runSource(ctx)
	case "target":
		err = runTarget(ctx, *once, *dry)
	default:
		err = errors.New("invalid_command")
	}
	if err != nil {
		slog.Error("exited", "code", public(err))
		os.Exit(1)
	}
}

func runSource(ctx context.Context) error {
	values, err := envfile.Load(required("CCH_ENV_FILE"))
	if err != nil {
		return errors.New("invalid_config")
	}
	token, err := source.LoadToken(required("CCH_SYNC_TOKEN_FILE"))
	if err != nil {
		return errors.New("invalid_config")
	}
	return source.Run(ctx, source.Config{
		Listen: os.Getenv("CCH_SYNC_LISTEN"), DSN: values["DSN"], Token: token,
		CertFile: os.Getenv("CCH_SYNC_TLS_CERT"), KeyFile: os.Getenv("CCH_SYNC_TLS_KEY"),
	})
}

func runTarget(ctx context.Context, once, dry bool) error {
	values, err := envfile.Load(required("CCH_ENV_FILE"))
	if err != nil {
		return errors.New("invalid_config")
	}
	token, err := source.LoadToken(required("CCH_SYNC_TOKEN_FILE"))
	if err != nil {
		return errors.New("invalid_config")
	}
	interval, err := time.ParseDuration(value("CCH_SYNC_INTERVAL", "60s"))
	if err != nil {
		return errors.New("invalid_config")
	}
	return target.Run(ctx, target.Config{
		SourceURL: os.Getenv("CCH_SYNC_SOURCE_URL"), DSN: values["DSN"], RedisURL: values["REDIS_URL"],
		Token: token, CAFile: os.Getenv("CCH_SYNC_CA_FILE"), PolicyFile: os.Getenv("CCH_SYNC_POLICY"),
		StateFile: value("CCH_SYNC_STATE", "/var/lib/cch-config-sync/state.json"),
		Interval:  interval, Once: once, DryRun: dry,
	})
}

func required(key string) string {
	value := os.Getenv(key)
	if value == "" {
		slog.Error("missing configuration", "name", key)
		os.Exit(2)
	}
	return value
}

func value(key, fallback string) string {
	if current := os.Getenv(key); current != "" {
		return current
	}
	return fallback
}

func public(err error) string {
	text := err.Error()
	if len(text) > 80 {
		return "internal_error"
	}
	return text
}

type flushWriter struct{ file *os.File }

func (writer flushWriter) Write(p []byte) (int, error) {
	count, err := writer.file.Write(p)
	_ = writer.file.Sync()
	return count, err
}
