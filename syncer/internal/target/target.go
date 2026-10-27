// Package target polls the source peer and applies changed configuration locally.
package target

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ding113/claude-code-hub/syncer/internal/apply"
	"github.com/ding113/claude-code-hub/syncer/internal/db"
	"github.com/ding113/claude-code-hub/syncer/internal/redisx"
	"github.com/ding113/claude-code-hub/syncer/internal/rules"
	"github.com/ding113/claude-code-hub/syncer/internal/snapshot"
	"github.com/ding113/claude-code-hub/syncer/internal/state"
	"github.com/jackc/pgx/v5"
	"github.com/klauspost/compress/zstd"
)

// Config controls one target peer.
type Config struct {
	SourceURL  string
	DSN        string
	RedisURL   string
	Token      string
	CAFile     string
	PolicyFile string
	StateFile  string
	Interval   time.Duration
	Once       bool
	DryRun     bool
}

// Run checks immediately and then once per interval until cancelled.
func Run(ctx context.Context, config Config) error {
	if config.SourceURL == "" || config.DSN == "" || config.Token == "" || config.CAFile == "" || config.PolicyFile == "" || config.StateFile == "" {
		return errors.New("invalid_config")
	}
	if config.Interval <= 0 {
		config.Interval = time.Minute
	}
	policy, policyDigest, err := loadPolicy(config.PolicyFile)
	if err != nil {
		return err
	}
	client, err := httpClient(config.CAFile)
	if err != nil {
		return err
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			err := syncOnce(ctx, client, config, policy, policyDigest)
			if err != nil {
				slog.Error("sync failed", "code", codeOf(err))
			}
			if config.Once {
				return err
			}
			timer.Reset(config.Interval)
		}
	}
}

func syncOnce(ctx context.Context, client *http.Client, config Config, policy rules.Policy, policyDigest string) error {
	callCtx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	body, err := fetch(callCtx, client, config.SourceURL, config.Token)
	if err != nil {
		return err
	}
	digest, err := snapshot.VerifyWire(body)
	if err != nil {
		return errors.New("bad_snapshot")
	}
	var snap snapshot.Snapshot
	current, err := state.Load(config.StateFile)
	if err != nil {
		slog.Warn("state unreadable; rediscovering target settings")
		current = state.File{}
	}
	if !config.DryRun && current.SourceDigest == digest && current.PolicyDigest == policyDigest {
		slog.Info("unchanged", "digest", digest[:12])
		return nil
	}
	schema, err := snapshot.SchemaOf(body)
	if err != nil {
		return errors.New("bad_snapshot")
	}
	if err = schemasMatch(callCtx, config.DSN, schema); err != nil {
		return err
	}
	if err = json.Unmarshal(body, &snap); err != nil || snap.Digest != digest {
		return errors.New("bad_snapshot")
	}
	tables := make(map[string][]map[string]any, len(snap.Tables))
	for name, rows := range snap.Tables {
		decoded, err := snapshot.DecodeRows(rows)
		if err != nil {
			return errors.New("bad_snapshot")
		}
		tables[name] = decoded
	}
	conn, err := db.Connect(callCtx, config.DSN)
	if err != nil {
		return err
	}
	defer conn.Close(callCtx)
	tx, err := conn.BeginTx(callCtx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(callCtx)
	result, err := apply.Apply(callCtx, tx, apply.Request{
		Schema: snap.Schema, Tables: tables, Policy: policy,
		FallbackLocalKey: current.LocalKey, FallbackProxyURL: current.ProxyURL, DryRun: config.DryRun,
	})
	if err != nil {
		return err
	}
	logResult(result, config.DryRun, snap.Digest)
	if config.DryRun || !result.Changed {
		if !config.DryRun {
			return state.Save(config.StateFile, state.File{
				SourceDigest: snap.Digest, PolicyDigest: policyDigest,
				LocalKey: result.Secrets.LocalKey, ProxyURL: result.Secrets.ProxyURL,
			})
		}
		return nil
	}
	if err := tx.Commit(callCtx); err != nil {
		return err
	}
	if config.RedisURL != "" {
		publishCtx, cancelPublish := context.WithTimeout(context.Background(), 2*time.Second)
		err = redisx.Publish(publishCtx, config.RedisURL, snap.Digest[:12])
		cancelPublish()
		if err != nil {
			slog.Warn("cache invalidation failed", "code", codeOf(err))
		}
	}
	return state.Save(config.StateFile, state.File{
		SourceDigest: snap.Digest, PolicyDigest: policyDigest,
		LocalKey: result.Secrets.LocalKey, ProxyURL: result.Secrets.ProxyURL,
	})
}

func fetch(ctx context.Context, client *http.Client, baseURL, token string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/snapshot", nil)
	if err != nil {
		return nil, errors.New("invalid_config")
	}
	request.Header.Set("Accept-Encoding", "zstd")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return nil, classifySourceError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("source_status_" + strconv.Itoa(response.StatusCode))
	}
	reader := io.Reader(response.Body)
	switch response.Header.Get("Content-Encoding") {
	case "zstd":
		decoded, err := zstd.NewReader(response.Body)
		if err != nil {
			return nil, errors.New("bad_snapshot")
		}
		defer decoded.Close()
		reader = decoded
	case "gzip":
		decoded, err := gzip.NewReader(response.Body)
		if err != nil {
			return nil, errors.New("bad_snapshot")
		}
		defer decoded.Close()
		reader = decoded
	}
	body, err := io.ReadAll(io.LimitReader(reader, 128<<20))
	if err != nil {
		return nil, classifySourceError(err)
	}
	return body, nil
}

func httpClient(caFile string) (*http.Client, error) {
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, errors.New("invalid_tls")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("invalid_tls")
	}
	return &http.Client{Transport: &http.Transport{
		Proxy: nil, ForceAttemptHTTP2: false,
		TLSNextProto:    map[string]func(string, *tls.Conn) http.RoundTripper{},
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	}}, nil
}

func loadPolicy(path string) (rules.Policy, string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return rules.Policy{}, "", errors.New("invalid_policy")
	}
	policy, err := rules.ParsePolicy(body)
	if err != nil {
		return rules.Policy{}, "", err
	}
	sum := sha256.Sum256(body)
	return policy, hex.EncodeToString(sum[:]), nil
}

func schemasMatch(ctx context.Context, dsn string, schema []snapshot.Column) error {
	conn, err := db.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	target, err := db.ReadSchema(ctx, tx)
	if err != nil {
		return err
	}
	if !apply.SchemasEqual(schema, target) {
		return errors.New("schema_mismatch")
	}
	return nil
}

func logResult(result apply.Result, dry bool, digest string) {
	slog.Info("planned", "dry_run", dry, "changed", result.Changed, "digest", digest[:12],
		"providers_insert", result.Providers.Insert, "providers_update", result.Providers.Update,
		"providers_delete", result.Providers.Delete, "providers_preserve", result.Providers.Preserve,
		"endpoints_insert", result.Endpoints.Insert, "endpoints_update", result.Endpoints.Update,
		"endpoints_delete", result.Endpoints.Delete, "endpoints_preserve", result.Endpoints.Preserve,
		"vendors_insert", result.Vendors.Insert, "vendors_update", result.Vendors.Update,
		"groups_insert", result.Groups.Insert, "groups_update", result.Groups.Update, "groups_delete", result.Groups.Delete,
		"prices_replaced", result.PricesReplaced, "catalog_replaced", result.CatalogReplaced)
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

func classifySourceError(err error) error {
	text := strings.NewReplacer(
		"https://100.64.1.38:23180/v1/snapshot", "source",
		" ", "_", ":", "_", "@", "_", "/", "_",
	).Replace(err.Error())
	if len(text) > 70 {
		text = text[:70]
	}
	return errors.New("src_" + text)
}
