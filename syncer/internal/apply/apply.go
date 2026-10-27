package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/ding113/claude-code-hub/syncer/internal/db"
	"github.com/ding113/claude-code-hub/syncer/internal/rules"
	"github.com/ding113/claude-code-hub/syncer/internal/snapshot"
	"github.com/jackc/pgx/v5"
)

const localHost = "127.0.0.1:52841"

// Counts reports one table's planned changes. Preserve is not modified.
type Counts struct {
	Insert   int `json:"insert"`
	Update   int `json:"update"`
	Delete   int `json:"delete"`
	Preserve int `json:"preserve,omitempty"`
}

// Secrets are target-owned values discovered from existing rows. Never log them.
type Secrets struct {
	LocalKey string
	ProxyURL string
}

// Result is safe to log only through its count fields.
type Result struct {
	Changed         bool
	Providers       Counts
	Endpoints       Counts
	Vendors         Counts
	Groups          Counts
	PricesReplaced  bool
	CatalogReplaced bool
	Secrets         Secrets
}

// Request selects the source snapshot and target-only overrides.
type Request struct {
	Schema           []snapshot.Column
	Tables           map[string][]map[string]any
	Policy           rules.Policy
	FallbackLocalKey string
	FallbackProxyURL string
	DryRun           bool
}

// Apply plans and, unless dry-run or unchanged, writes the target transaction.
func Apply(ctx context.Context, tx pgx.Tx, request Request) (Result, error) {
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '120s'`); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE public.provider_vendors, public.provider_groups, public.providers, public.provider_endpoints, public.model_prices, public.cloud_pricing_catalog IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return Result{}, err
	}
	targetSchema, err := db.ReadSchema(ctx, tx)
	if err != nil {
		return Result{}, err
	}
	if !jsonEqual(request.Schema, targetSchema) {
		return Result{}, errCode("schema_mismatch")
	}
	current := map[string][]map[string]any{}
	for _, table := range snapshot.Tables {
		rows, err := db.ReadTable(ctx, tx, table, table == "providers" || table == "provider_endpoints")
		if err != nil {
			return Result{}, err
		}
		current[table] = rows
	}
	preserved, err := preservedRows(current["providers"], request.Policy.PreserveProviders)
	if err != nil {
		return Result{}, err
	}
	targetDomains, err := domainsByID(current["provider_vendors"])
	if err != nil {
		return Result{}, err
	}
	preservedDomains, preservedPools, err := preservedScope(preserved, targetDomains)
	if err != nil {
		return Result{}, err
	}
	secrets, err := discover(current["providers"], nameSet(request.Policy.PreserveProviders), Secrets{
		LocalKey: request.FallbackLocalKey, ProxyURL: request.FallbackProxyURL,
	})
	if err != nil {
		return Result{}, err
	}
	desired, err := desiredTables(request.Tables, append(rules.TargetOverrides(secrets.LocalKey, secrets.ProxyURL), request.Policy.Rules...), nameSet(request.Policy.PreserveProviders))
	if err != nil {
		return Result{}, err
	}
	if len(desired["providers"]) == 0 {
		return Result{}, errCode("empty_source")
	}
	if len(desired["model_prices"]) == 0 {
		return Result{}, errCode("empty_prices")
	}
	sourceDomains, err := domainsByID(desired["provider_vendors"])
	if err != nil {
		return Result{}, err
	}
	vendorDesired, err := naturalRecords(filterDomains(desired["provider_vendors"], preservedDomains, false), "website_domain", metaField)
	if err != nil {
		return Result{}, err
	}
	vendorCurrent, err := naturalRecords(filterDomains(current["provider_vendors"], preservedDomains, false), "website_domain", metaField)
	if err != nil {
		return Result{}, err
	}
	vendorPlan, err := planRecords(vendorDesired, vendorCurrent)
	if err != nil {
		return Result{}, err
	}
	vendorPlan.deletes = nil
	groupDesired, err := naturalRecords(desired["provider_groups"], "name", metaField)
	if err != nil {
		return Result{}, err
	}
	groupCurrent, err := naturalRecords(current["provider_groups"], "name", metaField)
	if err != nil {
		return Result{}, err
	}
	groupPlan, err := planRecords(groupDesired, groupCurrent)
	if err != nil {
		return Result{}, err
	}
	providerDesired, err := providerRecords(desired["providers"], sourceDomains, "provider_vendor_id")
	if err != nil {
		return Result{}, err
	}
	providerCurrent, err := providerRecords(excludeNames(current["providers"], nameSet(request.Policy.PreserveProviders)), targetDomains, "provider_vendor_id")
	if err != nil {
		return Result{}, err
	}
	providerPlan, err := planRecords(providerDesired, providerCurrent)
	if err != nil {
		return Result{}, err
	}
	if err := guardPreserved(providerPlan.deletes, preserved); err != nil {
		return Result{}, err
	}
	endpointDesired, err := providerRecords(filterPools(desired["provider_endpoints"], sourceDomains, preservedPools), sourceDomains, "vendor_id")
	if err != nil {
		return Result{}, err
	}
	endpointCurrent, err := providerRecords(filterPools(current["provider_endpoints"], targetDomains, preservedPools), targetDomains, "vendor_id")
	if err != nil {
		return Result{}, err
	}
	endpointPlan, err := planRecords(endpointDesired, endpointCurrent)
	if err != nil {
		return Result{}, err
	}
	pricesChanged, err := semanticDiff(desired["model_prices"], current["model_prices"], func(field string) bool { return field != "id" })
	if err != nil {
		return Result{}, err
	}
	catalogChanged, err := semanticDiff(desired["cloud_pricing_catalog"], current["cloud_pricing_catalog"], func(field string) bool { return field != "id" })
	if err != nil {
		return Result{}, err
	}
	result := Result{
		Providers:       counts(providerPlan, len(preserved)),
		Endpoints:       counts(endpointPlan, countPools(current["provider_endpoints"], targetDomains, preservedPools)),
		Vendors:         counts(vendorPlan, len(preservedDomains)),
		Groups:          counts(groupPlan, 0),
		PricesReplaced:  pricesChanged,
		CatalogReplaced: catalogChanged,
		Secrets:         secrets,
	}
	result.Changed = providerPlan.changed() || endpointPlan.changed() || vendorPlan.changed() || groupPlan.changed() || pricesChanged || catalogChanged
	if request.DryRun || !result.Changed {
		return result, nil
	}
	columns := columnsByTable(targetSchema)
	if err := upsertNatural(ctx, tx, "provider_vendors", append(vendorPlan.inserts, recordsFromPairs(vendorPlan.updates)...), columns, []string{"website_domain", "display_name", "website_url", "favicon_url"}, "website_domain"); err != nil {
		return Result{}, err
	}
	refreshed, err := db.ReadTable(ctx, tx, "provider_vendors", false)
	if err != nil {
		return Result{}, err
	}
	targetDomains, err = domainsByID(refreshed)
	if err != nil {
		return Result{}, err
	}
	domainIDs := reverseDomains(targetDomains)
	if err := upsertNatural(ctx, tx, "provider_groups", append(groupPlan.inserts, recordsFromPairs(groupPlan.updates)...), columns, []string{"name", "cost_multiplier", "description"}, "name"); err != nil {
		return Result{}, err
	}
	if err := deleteIDs(ctx, tx, "provider_groups", groupPlan.deletes); err != nil {
		return Result{}, err
	}
	if err := syncIdentity(ctx, tx, "providers", providerPlan, columns, "provider_vendor_id", sourceDomains, domainIDs); err != nil {
		return Result{}, err
	}
	if err := syncIdentity(ctx, tx, "provider_endpoints", endpointPlan, columns, "vendor_id", sourceDomains, domainIDs); err != nil {
		return Result{}, err
	}
	if pricesChanged {
		if err := replaceRows(ctx, tx, "model_prices", desired["model_prices"], []string{"model_name", "price_data", "source", "created_at", "updated_at"}); err != nil {
			return Result{}, err
		}
	}
	if catalogChanged {
		catalogColumns := without(columns["cloud_pricing_catalog"], "id")
		if err := replaceRows(ctx, tx, "cloud_pricing_catalog", desired["cloud_pricing_catalog"], catalogColumns); err != nil {
			return Result{}, err
		}
	}
	return result, nil
}

func desiredTables(source map[string][]map[string]any, overrides []rules.Rule, preserved map[string]bool) (map[string][]map[string]any, error) {
	desired := make(map[string][]map[string]any, len(snapshot.Tables))
	for _, table := range snapshot.Tables {
		rows := source[table]
		if rows == nil {
			return nil, errCode("bad_snapshot")
		}
		next := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if table == "providers" && preserved[stringOf(row["name"])] {
				continue
			}
			updated, err := rules.Apply(table, row, overrides)
			if err != nil {
				return nil, err
			}
			if table == "providers" && preserved[stringOf(updated["name"])] {
				continue
			}
			next = append(next, updated)
		}
		desired[table] = next
	}
	return desired, nil
}

func discover(rows []map[string]any, preserved map[string]bool, fallback Secrets) (Secrets, error) {
	keys := map[string]struct{}{}
	proxies := map[string]struct{}{}
	localRows := 0
	for _, row := range rows {
		if preserved[stringOf(row["name"])] {
			continue
		}
		host, err := rowHost(row)
		if err != nil {
			return Secrets{}, err
		}
		switch {
		case host == localHost:
			localRows++
			key := stringOf(row["key"])
			if key == "" {
				return Secrets{}, errCode("local_key_missing")
			}
			keys[key] = struct{}{}
		case strings.HasPrefix(host, "127.0.0.1:"):
		default:
			proxy := stringOf(row["proxy_url"])
			if proxy == "" {
				return Secrets{}, errCode("proxy_missing")
			}
			proxies[proxy] = struct{}{}
		}
	}
	switch {
	case localRows == 0:
		if fallback.LocalKey == "" {
			return Secrets{}, errCode("local_key_missing")
		}
	case len(keys) != 1:
		return Secrets{}, errCode("local_key_ambiguous")
	default:
		for key := range keys {
			fallback.LocalKey = key
		}
	}
	switch len(proxies) {
	case 0:
		if fallback.ProxyURL == "" {
			return Secrets{}, errCode("proxy_missing")
		}
	case 1:
		for proxy := range proxies {
			fallback.ProxyURL = proxy
		}
	default:
		return Secrets{}, errCode("proxy_ambiguous")
	}
	return fallback, nil
}

func syncIdentity(ctx context.Context, tx pgx.Tx, table string, plan tablePlan, columns map[string][]string, vendorField string, sourceDomains map[int64]string, targetIDs map[string]int64) error {
	if err := deleteIDs(ctx, tx, table, plan.deletes); err != nil {
		return err
	}
	for _, change := range plan.updates {
		row, err := remapVendor(change.desired.raw, vendorField, sourceDomains, targetIDs)
		if err != nil {
			return err
		}
		if err := updateRow(ctx, tx, table, change.current.id, row, columns[table]); err != nil {
			return err
		}
	}
	for _, row := range plan.inserts {
		mapped, err := remapVendor(row.raw, vendorField, sourceDomains, targetIDs)
		if err != nil {
			return err
		}
		if _, err := insertRow(ctx, tx, table, mapped, columns[table]); err != nil {
			return err
		}
	}
	return nil
}

func remapVendor(row map[string]any, field string, sourceDomains map[int64]string, targetIDs map[string]int64) (map[string]any, error) {
	vendorID, err := integer(row[field])
	if err != nil {
		return nil, err
	}
	domain := sourceDomains[vendorID]
	targetID, ok := targetIDs[domain]
	if !ok {
		return nil, errCode("missing_vendor")
	}
	next := make(map[string]any, len(row))
	for key, value := range row {
		next[key] = value
	}
	next[field] = json.Number(fmt.Sprintf("%d", targetID))
	return next, nil
}

func upsertNatural(ctx context.Context, tx pgx.Tx, table string, rows []record, columns map[string][]string, fields []string, conflict string) error {
	if len(rows) == 0 {
		return nil
	}
	quoted, err := quoteList(fields)
	if err != nil {
		return err
	}
	conflictName, err := quoteIdent(conflict)
	if err != nil {
		return err
	}
	assignments := make([]string, 0, len(fields))
	for _, field := range fields {
		if field == conflict {
			continue
		}
		name, err := quoteIdent(field)
		if err != nil {
			return err
		}
		assignments = append(assignments, name+" = EXCLUDED."+name)
	}
	tableName, err := quoteIdent(table)
	if err != nil {
		return err
	}
	query := fmt.Sprintf(`INSERT INTO public.%s (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%s, $1::jsonb) ON CONFLICT (%s) DO UPDATE SET %s, updated_at = now()`,
		tableName, strings.Join(quoted, ", "), strings.Join(quoted, ", "), tableName, conflictName, strings.Join(assignments, ", "))
	for _, row := range rows {
		payload, err := json.Marshal(subset(row.raw, fields))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, query, string(payload)); err != nil {
			return err
		}
	}
	_ = columns
	return nil
}

func updateRow(ctx context.Context, tx pgx.Tx, table string, id int64, row map[string]any, columns []string) error {
	fields := included(columns, row, func(field string) bool { return !updateExcluded(table, field) })
	quoted, err := quoteList(fields)
	if err != nil {
		return err
	}
	tableName, err := quoteIdent(table)
	if err != nil {
		return err
	}
	query := fmt.Sprintf(`UPDATE public.%s AS t SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%s, $2::jsonb)), updated_at = now() WHERE t.id = $1 AND t.deleted_at IS NULL`,
		tableName, strings.Join(quoted, ", "), strings.Join(quoted, ", "), tableName)
	payload, err := json.Marshal(subset(row, fields))
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, query, id, string(payload))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errCode("update_missed")
	}
	return nil
}

func insertRow(ctx context.Context, tx pgx.Tx, table string, row map[string]any, columns []string) (int64, error) {
	fields := included(columns, row, func(field string) bool { return !insertExcluded(table, field) })
	quoted, err := quoteList(fields)
	if err != nil {
		return 0, err
	}
	tableName, err := quoteIdent(table)
	if err != nil {
		return 0, err
	}
	query := fmt.Sprintf(`INSERT INTO public.%s (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%s, $1::jsonb) RETURNING id`,
		tableName, strings.Join(quoted, ", "), strings.Join(quoted, ", "), tableName)
	payload, err := json.Marshal(subset(row, fields))
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, query, string(payload)).Scan(&id)
	return id, err
}

func replaceRows(ctx context.Context, tx pgx.Tx, table string, rows []map[string]any, fields []string) error {
	tableName, err := quoteIdent(table)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM public.`+tableName); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	quoted, err := quoteList(fields)
	if err != nil {
		return err
	}
	payloadRows := make([]map[string]any, len(rows))
	for index, row := range rows {
		payloadRows[index] = subset(row, fields)
	}
	payload, err := json.Marshal(payloadRows)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, fmt.Sprintf(`INSERT INTO public.%s (%s) SELECT %s FROM jsonb_populate_recordset(NULL::public.%s, $1::jsonb)`,
		tableName, strings.Join(quoted, ", "), strings.Join(quoted, ", "), tableName), string(payload))
	return err
}

func deleteIDs(ctx context.Context, tx pgx.Tx, table string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tableName, err := quoteIdent(table)
	if err != nil {
		return err
	}
	query := `DELETE FROM public.` + tableName + ` WHERE id = $1`
	if table == "providers" || table == "provider_endpoints" {
		query = `UPDATE public.` + tableName + ` SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, query, id); err != nil {
			return err
		}
	}
	return nil
}

func insertExcluded(table, field string) bool {
	if field == "id" || field == "created_at" || field == "updated_at" || field == "deleted_at" || field == "total_cost_reset_at" {
		return true
	}
	return table == "provider_endpoints" && strings.HasPrefix(field, "last_probe")
}

func updateExcluded(table, field string) bool {
	if field == "id" || field == "created_at" || field == "deleted_at" || field == "updated_at" || field == "total_cost_reset_at" {
		return true
	}
	return table == "provider_endpoints" && strings.HasPrefix(field, "last_probe")
}

func included(columns []string, row map[string]any, keep func(string) bool) []string {
	fields := make([]string, 0, len(columns))
	for _, column := range columns {
		if _, ok := row[column]; ok && keep(column) {
			fields = append(fields, column)
		}
	}
	sort.Strings(fields)
	return fields
}

func subset(row map[string]any, fields []string) map[string]any {
	out := make(map[string]any, len(fields))
	for _, field := range fields {
		out[field] = row[field]
	}
	return out
}

func preservedRows(rows []map[string]any, names []string) ([]map[string]any, error) {
	wanted := nameSet(names)
	found := map[string]int{}
	var preserved []map[string]any
	for _, row := range rows {
		name := stringOf(row["name"])
		if !wanted[name] {
			continue
		}
		found[name]++
		preserved = append(preserved, row)
	}
	for _, name := range names {
		if found[name] != 1 {
			return nil, errCode("missing_preserved_provider")
		}
	}
	return preserved, nil
}

func preservedScope(rows []map[string]any, domains map[int64]string) (map[string]bool, map[string]bool, error) {
	domainSet := map[string]bool{}
	pools := map[string]bool{}
	for _, row := range rows {
		id, err := integer(row["provider_vendor_id"])
		if err != nil {
			return nil, nil, err
		}
		domain := domains[id]
		if domain == "" {
			return nil, nil, errCode("missing_vendor")
		}
		domainSet[domain] = true
		pools[domain+"\x00"+stringOf(row["provider_type"])] = true
	}
	return domainSet, pools, nil
}

func filterDomains(rows []map[string]any, preserved map[string]bool, keep bool) []map[string]any {
	var out []map[string]any
	for _, row := range rows {
		if preserved[stringOf(row["website_domain"])] == keep {
			out = append(out, row)
		}
	}
	return out
}

func filterPools(rows []map[string]any, domains map[int64]string, pools map[string]bool) []map[string]any {
	var out []map[string]any
	for _, row := range rows {
		id, err := integer(row["vendor_id"])
		if err != nil {
			continue
		}
		if pools[domains[id]+"\x00"+stringOf(row["provider_type"])] {
			continue
		}
		out = append(out, row)
	}
	return out
}

func countPools(rows []map[string]any, domains map[int64]string, pools map[string]bool) int {
	count := 0
	for _, row := range rows {
		id, err := integer(row["vendor_id"])
		if err == nil && pools[domains[id]+"\x00"+stringOf(row["provider_type"])] {
			count++
		}
	}
	return count
}

func excludeNames(rows []map[string]any, names map[string]bool) []map[string]any {
	var out []map[string]any
	for _, row := range rows {
		if !names[stringOf(row["name"])] {
			out = append(out, row)
		}
	}
	return out
}

func domainsByID(rows []map[string]any) (map[int64]string, error) {
	domains := make(map[int64]string, len(rows))
	for _, row := range rows {
		id, err := integer(row["id"])
		if err != nil {
			return nil, err
		}
		domain := stringOf(row["website_domain"])
		if domain == "" {
			return nil, errCode("missing_vendor")
		}
		domains[id] = domain
	}
	return domains, nil
}

func reverseDomains(domains map[int64]string) map[string]int64 {
	reversed := make(map[string]int64, len(domains))
	for id, domain := range domains {
		reversed[domain] = id
	}
	return reversed
}

func semanticDiff(desired, current []map[string]any, include func(string) bool) (bool, error) {
	left, err := snapshot.Semantic(projectAll(desired, include))
	if err != nil {
		return false, err
	}
	right, err := snapshot.Semantic(projectAll(current, include))
	if err != nil {
		return false, err
	}
	return left != right, nil
}

func projectAll(rows []map[string]any, include func(string) bool) []map[string]any {
	views := make([]map[string]any, len(rows))
	for index, row := range rows {
		views[index] = projected(row, include)
	}
	return views
}

func metaField(field string) bool {
	return field != "id" && field != "created_at" && field != "updated_at"
}

func counts(plan tablePlan, preserved int) Counts {
	return Counts{Insert: len(plan.inserts), Update: len(plan.updates), Delete: len(plan.deletes), Preserve: preserved}
}

func recordsFromPairs(pairs []pair) []record {
	rows := make([]record, len(pairs))
	for index, pair := range pairs {
		rows[index] = pair.desired
	}
	return rows
}

func guardPreserved(ids []int64, preserved []map[string]any) error {
	keep := map[int64]bool{}
	for _, row := range preserved {
		id, err := integer(row["id"])
		if err != nil {
			return err
		}
		keep[id] = true
	}
	for _, id := range ids {
		if keep[id] {
			return errCode("preserved_delete")
		}
	}
	return nil
}

func columnsByTable(columns []snapshot.Column) map[string][]string {
	grouped := map[string][]string{}
	for _, column := range columns {
		grouped[column.Table] = append(grouped[column.Table], column.Name)
	}
	return grouped
}

func without(columns []string, field string) []string {
	var out []string
	for _, column := range columns {
		if column != field {
			out = append(out, column)
		}
	}
	return out
}

func nameSet(names []string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	return set
}

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

func rowHost(row map[string]any) (string, error) {
	parsed, err := url.Parse(stringOf(row["url"]))
	if err != nil || parsed.Host == "" {
		return "", errCode("invalid_url")
	}
	return parsed.Host, nil
}

func jsonEqual(left, right any) bool {
	a, errA := json.Marshal(left)
	b, errB := json.Marshal(right)
	return errA == nil && errB == nil && string(a) == string(b)
}

// SchemasEqual reports whether two column lists marshal to the same JSON.
func SchemasEqual(left, right []snapshot.Column) bool {
	return jsonEqual(left, right)
}

func quoteIdent(value string) (string, error) {
	for _, char := range value {
		if char != '_' && (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return "", errCode("invalid_identifier")
		}
	}
	if value == "" || value[0] >= '0' && value[0] <= '9' {
		return "", errCode("invalid_identifier")
	}
	return `"` + value + `"`, nil
}

func quoteList(fields []string) ([]string, error) {
	quoted := make([]string, len(fields))
	for index, field := range fields {
		name, err := quoteIdent(field)
		if err != nil {
			return nil, err
		}
		quoted[index] = name
	}
	return quoted, nil
}
