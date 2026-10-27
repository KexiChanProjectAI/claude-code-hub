package apply

import "testing"

func TestPlanKeepsMatchesAndRemovesOnlyMissing(t *testing.T) {
	desired := []record{
		{key: "same", view: map[string]any{"name": "same"}},
		{key: "changed", view: map[string]any{"name": "changed", "priority": "2"}},
		{key: "new", view: map[string]any{"name": "new"}},
	}
	current := []record{
		{id: 7, key: "same", view: map[string]any{"name": "same"}},
		{id: 8, key: "changed", view: map[string]any{"name": "changed", "priority": "1"}},
		{id: 9, key: "old", view: map[string]any{"name": "old"}},
	}
	plan, err := planRecords(desired, current)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.inserts) != 1 || plan.inserts[0].key != "new" {
		t.Fatalf("inserts = %#v", plan.inserts)
	}
	if len(plan.updates) != 1 || plan.updates[0].current.id != 8 {
		t.Fatalf("updates = %#v", plan.updates)
	}
	if len(plan.deletes) != 1 || plan.deletes[0] != 9 {
		t.Fatalf("deletes = %#v", plan.deletes)
	}
}

func TestPlanRejectsDuplicateTargetIdentity(t *testing.T) {
	_, err := planRecords(nil, []record{{id: 1, key: "a"}, {id: 2, key: "a"}})
	if err == nil || err.Error() != "duplicate_target_identity" {
		t.Fatalf("error = %v", err)
	}
}
