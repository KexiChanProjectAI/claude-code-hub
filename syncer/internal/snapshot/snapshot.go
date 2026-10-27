// Package snapshot defines the peer payload and value normalization used to detect changes.
package snapshot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"sort"
	"strings"
	"time"
)

// Column is one compared database column. Names and formatted types must match exactly.
type Column struct {
	Table string `json:"table"`
	Name  string `json:"name"`
	Type  string `json:"type"`
}

// Snapshot is the source response. Digest covers schema and tables, never credentials in logs.
type Snapshot struct {
	Schema []Column                     `json:"schema"`
	Tables map[string][]json.RawMessage `json:"tables"`
	Digest string                       `json:"digest"`
}

var Tables = []string{
	"provider_vendors", "provider_groups", "providers", "provider_endpoints",
	"model_prices", "cloud_pricing_catalog",
}

// DecodeRows parses snapshot rows without turning numeric values into float64.
func DecodeRows(raws []json.RawMessage) ([]map[string]any, error) {
	rows := make([]map[string]any, 0, len(raws))
	for _, raw := range raws {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var row map[string]any
		if err := decoder.Decode(&row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// EncodeRows returns canonically ordered JSON objects.
func EncodeRows(rows []map[string]any) ([]json.RawMessage, error) {
	raws := make([]json.RawMessage, len(rows))
	for index, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		raws[index] = encoded
	}
	return raws, nil
}

// Digest is the lowercase SHA-256 of the canonical schema and table payload.
func Digest(schema []Column, tables map[string][]map[string]any) (string, error) {
	encoded, err := json.Marshal(map[string]any{"schema": schema, "tables": tables})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// Verify checks that the payload digest matches its canonical content.
func Verify(body Snapshot) error {
	decoded := make(map[string][]map[string]any, len(body.Tables))
	for table, rows := range body.Tables {
		parsed, err := DecodeRows(rows)
		if err != nil {
			return err
		}
		decoded[table] = parsed
	}
	actual, err := Digest(body.Schema, decoded)
	if err != nil {
		return err
	}
	if actual != body.Digest {
		return errDigest
	}
	return nil
}

type digestError struct{}

func (digestError) Error() string { return "bad_snapshot" }

var errDigest error = digestError{}

// Semantic hashes structurally identical values. Numeric formatting and timestamp
// offsets do not create a difference; array order does.
func Semantic(rows []map[string]any) (string, error) {
	parts := make([]string, len(rows))
	for index, row := range rows {
		encoded, err := json.Marshal(normalize(row))
		if err != nil {
			return "", err
		}
		parts[index] = string(encoded)
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:]), nil
}

func normalize(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		next := make(map[string]any, len(typed))
		for key, child := range typed {
			next[key] = normalize(child)
		}
		return next
	case []any:
		next := make([]any, len(typed))
		for index, child := range typed {
			next[index] = normalize(child)
		}
		return next
	case json.Number:
		if rational, ok := new(big.Rat).SetString(strings.TrimSpace(typed.String())); ok {
			return "n:" + rational.RatString()
		}
		return typed.String()
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return "t:" + parsed.UTC().Format(time.RFC3339Nano)
		}
		return typed
	default:
		return value
	}
}
