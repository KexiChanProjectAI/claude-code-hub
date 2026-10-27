package apply

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/ding113/claude-code-hub/syncer/internal/snapshot"
)

const (
	actionInsert = "insert"
	actionUpdate = "update"
	actionDelete = "delete"
)

type record struct {
	id   int64
	key  string
	view map[string]any
	raw  map[string]any
}

type pair struct {
	current record
	desired record
}

type tablePlan struct {
	updates []pair
	inserts []record
	deletes []int64
}

func (plan tablePlan) changed() bool {
	return len(plan.updates) > 0 || len(plan.inserts) > 0 || len(plan.deletes) > 0
}

func planRecords(desired, current []record) (tablePlan, error) {
	desiredByKey := map[string]record{}
	for _, row := range desired {
		if _, exists := desiredByKey[row.key]; exists {
			return tablePlan{}, errCode("duplicate_source_identity")
		}
		desiredByKey[row.key] = row
	}
	currentByKey := map[string]record{}
	for _, row := range current {
		if _, exists := currentByKey[row.key]; exists {
			return tablePlan{}, errCode("duplicate_target_identity")
		}
		currentByKey[row.key] = row
	}
	var plan tablePlan
	for key, want := range desiredByKey {
		have, exists := currentByKey[key]
		if !exists {
			plan.inserts = append(plan.inserts, want)
			continue
		}
		equal, err := sameView(want.view, have.view)
		if err != nil {
			return tablePlan{}, err
		}
		if !equal {
			plan.updates = append(plan.updates, pair{current: have, desired: want})
		}
	}
	for key, have := range currentByKey {
		if _, exists := desiredByKey[key]; !exists {
			plan.deletes = append(plan.deletes, have.id)
		}
	}
	sort.Slice(plan.inserts, func(i, j int) bool { return plan.inserts[i].key < plan.inserts[j].key })
	sort.Slice(plan.updates, func(i, j int) bool { return plan.updates[i].desired.key < plan.updates[j].desired.key })
	sort.Slice(plan.deletes, func(i, j int) bool { return plan.deletes[i] < plan.deletes[j] })
	return plan, nil
}

func sameView(left, right map[string]any) (bool, error) {
	a, err := snapshot.Semantic([]map[string]any{left})
	if err != nil {
		return false, err
	}
	b, err := snapshot.Semantic([]map[string]any{right})
	if err != nil {
		return false, err
	}
	return a == b, nil
}

func providerRecords(rows []map[string]any, domains map[int64]string, idField string) ([]record, error) {
	records := make([]record, 0, len(rows))
	for _, row := range rows {
		id, err := integer(row["id"])
		if err != nil {
			return nil, err
		}
		vendorID, err := integer(row[idField])
		if err != nil {
			return nil, err
		}
		domain, ok := domains[vendorID]
		if !ok || domain == "" {
			return nil, errCode("missing_vendor")
		}
		view := projected(row, func(field string) bool {
			switch field {
			case "id", idField, "created_at", "updated_at", "deleted_at", "total_cost_reset_at":
				return false
			default:
				return !strings.HasPrefix(field, "last_probe")
			}
		})
		view["vendor_domain"] = domain
		name, _ := row["name"].(string)
		kind, _ := row["provider_type"].(string)
		endpointURL, _ := row["url"].(string)
		key := name + "\x00" + kind
		if idField == "vendor_id" {
			key = domain + "\x00" + kind + "\x00" + endpointURL
		}
		records = append(records, record{id: id, key: key, view: view, raw: row})
	}
	return records, nil
}

func naturalRecords(rows []map[string]any, keyField string, exclude func(string) bool) ([]record, error) {
	records := make([]record, 0, len(rows))
	for _, row := range rows {
		id, err := integer(row["id"])
		if err != nil {
			return nil, err
		}
		key, _ := row[keyField].(string)
		if key == "" {
			return nil, errCode("missing_identity")
		}
		records = append(records, record{id: id, key: key, view: projected(row, exclude), raw: row})
	}
	return records, nil
}

func projected(row map[string]any, include func(string) bool) map[string]any {
	view := make(map[string]any, len(row))
	for field, value := range row {
		if include(field) {
			view[field] = value
		}
	}
	return view
}

func integer(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return typed.Int64()
	case int64:
		return typed, nil
	case float64:
		return int64(typed), nil
	default:
		return 0, errCode("bad_id")
	}
}

type coded string

func (e coded) Error() string { return string(e) }

func errCode(value string) error { return coded(value) }
