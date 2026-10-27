// Package db reads CCH configuration tables. It does not log connection strings.
package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/ding113/claude-code-hub/syncer/internal/snapshot"
	"github.com/jackc/pgx/v5"
)

// Connect opens one PostgreSQL session for the syncer.
func Connect(ctx context.Context, dsn string) (*pgx.Conn, error) {
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	config.RuntimeParams["application_name"] = "cch-config-sync"
	return pgx.ConnectConfig(ctx, config)
}

// ReadSchema returns column names and formatted types in comparison order.
func ReadSchema(ctx context.Context, tx pgx.Tx) ([]snapshot.Column, error) {
	rows, err := tx.Query(ctx, `
		SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
		  AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY c.relname, a.attname`, snapshot.Tables)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var columns []snapshot.Column
	for rows.Next() {
		var column snapshot.Column
		if err := rows.Scan(&column.Table, &column.Name, &column.Type); err != nil {
			return nil, err
		}
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

// ReadTable reads one configuration table as JSON objects.
func ReadTable(ctx context.Context, tx pgx.Tx, table string, activeOnly bool) ([]map[string]any, error) {
	if !validTable(table) {
		return nil, fmt.Errorf("invalid_table")
	}
	filter := ""
	if activeOnly {
		filter = "WHERE deleted_at IS NULL"
	}
	rows, err := tx.Query(ctx, fmt.Sprintf(
		`SELECT row_to_json(t)::text FROM public.%s t %s ORDER BY id`, quote(table), filter))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var decoded []map[string]any
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.UseNumber()
		var row map[string]any
		if err := decoder.Decode(&row); err != nil {
			return nil, err
		}
		decoded = append(decoded, row)
	}
	if decoded == nil {
		decoded = []map[string]any{}
	}
	return decoded, rows.Err()
}

// ReadSnapshot loads one canonical snapshot document. Decoded row maps are not retained.
func ReadSnapshot(ctx context.Context, conn *pgx.Conn) ([]byte, error) {
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	schema, err := ReadSchema(ctx, tx)
	if err != nil {
		return nil, err
	}
	names := append([]string(nil), snapshot.Tables...)
	sort.Strings(names)
	assembler, err := snapshot.NewAssembler(schema, names)
	if err != nil {
		return nil, err
	}
	for _, table := range names {
		if err = assembler.BeginTable(table); err != nil {
			return nil, err
		}
		if err = writeTable(ctx, tx, assembler, table, table == "providers" || table == "provider_endpoints"); err != nil {
			return nil, err
		}
		if err = assembler.EndTable(); err != nil {
			return nil, err
		}
	}
	return assembler.Finish()
}

func writeTable(ctx context.Context, tx pgx.Tx, assembler *snapshot.Assembler, table string, activeOnly bool) error {
	if !validTable(table) {
		return fmt.Errorf("invalid_table")
	}
	filter := ""
	if activeOnly {
		filter = "WHERE deleted_at IS NULL"
	}
	rows, err := tx.Query(ctx, fmt.Sprintf(
		`SELECT row_to_json(t)::text FROM public.%s t %s ORDER BY id`, quote(table), filter))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		if err = assembler.WriteRow(raw); err != nil {
			return err
		}
	}
	return rows.Err()
}

func validTable(table string) bool {
	for _, candidate := range snapshot.Tables {
		if candidate == table {
			return true
		}
	}
	return false
}

func quote(table string) string { return `"` + table + `"` }
