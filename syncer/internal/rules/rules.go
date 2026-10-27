// Package rules applies the same conditional field overrides as scripts/sync-cch-config.ts.
package rules

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

var tables = map[string]bool{
	"provider_vendors": true, "provider_groups": true, "providers": true,
	"provider_endpoints": true, "model_prices": true, "cloud_pricing_catalog": true,
}

var protected = map[string]bool{
	"id": true, "provider_vendor_id": true, "vendor_id": true, "created_at": true,
	"updated_at": true, "deleted_at": true, "total_cost_reset_at": true,
	"__proto__": true, "prototype": true, "constructor": true,
}

// Rule is one ordered override. A rule without When matches every row of its tables.
type Rule struct {
	Tables []string       `json:"tables"`
	When   *Condition     `json:"when,omitempty"`
	Set    map[string]any `json:"set"`
}

// Condition compares one field using strict equality or SQL LIKE semantics.
type Condition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

// Policy is the target-owned preservation and final override document.
type Policy struct {
	PreserveProviders []string `json:"preserveProviders"`
	Rules             []Rule   `json:"rules"`
}

type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

func code(value string) error { return &Error{Code: value} }

// ParsePolicy validates a policy document and rejects unknown fields.
func ParsePolicy(raw []byte) (Policy, error) {
	var rawMap map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawMap); err != nil {
		return Policy{}, code("invalid_policy")
	}
	for key := range rawMap {
		if key != "preserveProviders" && key != "rules" {
			return Policy{}, code("invalid_policy")
		}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var policy Policy
	if err := decoder.Decode(&policy); err != nil {
		return Policy{}, code("invalid_policy")
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(policy.PreserveProviders))
	for _, name := range policy.PreserveProviders {
		if strings.TrimSpace(name) == "" || seen[name] {
			if strings.TrimSpace(name) == "" {
				return Policy{}, code("invalid_policy")
			}
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	rules, err := parseRules(policy.Rules)
	if err != nil {
		return Policy{}, err
	}
	return Policy{PreserveProviders: names, Rules: rules}, nil
}

func parseRules(values []Rule) ([]Rule, error) {
	for index := range values {
		rule := values[index]
		if len(rule.Tables) == 0 || len(rule.Set) == 0 {
			return nil, code("invalid_rules")
		}
		for _, table := range rule.Tables {
			if !tables[table] {
				return nil, code("invalid_rules")
			}
		}
		for field := range rule.Set {
			if err := validateField(field); err != nil {
				return nil, err
			}
		}
		if rule.When != nil {
			if (rule.When.Op != "eq" && rule.When.Op != "ne" && rule.When.Op != "like" && rule.When.Op != "not_like") ||
				((rule.When.Op == "like" || rule.When.Op == "not_like") && !isString(rule.When.Value)) {
				return nil, code("invalid_rules")
			}
			if err := validateField(rule.When.Field); err != nil {
				return nil, err
			}
		}
	}
	return values, nil
}

func validateField(field string) error {
	if field == "url.host" {
		return nil
	}
	for _, part := range strings.Split(field, ".") {
		if part == "" || protected[part] || strings.HasPrefix(part, "last_probe") {
			return code("invalid_field")
		}
	}
	return nil
}

// TargetOverrides rewrites local sub2api credentials and applies one target proxy to external providers.
func TargetOverrides(localKey, proxyURL string) []Rule {
	return []Rule{
		{Tables: []string{"providers"}, When: &Condition{Field: "url.host", Op: "eq", Value: "127.0.0.1:52841"},
			Set: map[string]any{"proxy_url": nil, "key": localKey}},
		{Tables: []string{"providers"}, When: &Condition{Field: "url.host", Op: "not_like", Value: "127.0.0.1:%"},
			Set: map[string]any{"proxy_url": proxyURL}},
	}
}

// Apply returns a modified copy. Later rules observe earlier writes.
func Apply(table string, row map[string]any, values []Rule) (map[string]any, error) {
	next, err := cloneMap(row)
	if err != nil {
		return nil, err
	}
	for _, rule := range values {
		if !contains(rule.Tables, table) {
			continue
		}
		matched, err := matches(next, rule.When)
		if err != nil || !matched {
			if err != nil {
				return nil, err
			}
			continue
		}
		for field, value := range rule.Set {
			if err := setField(next, field, value); err != nil {
				return nil, err
			}
		}
	}
	return next, nil
}

func matches(row map[string]any, when *Condition) (bool, error) {
	if when == nil {
		return true, nil
	}
	actual, err := getField(row, when.Field)
	if err != nil {
		return false, err
	}
	switch when.Op {
	case "eq", "ne":
		equal, err := jsonEqual(actual, when.Value)
		if err != nil {
			return false, err
		}
		if when.Op == "ne" {
			return !equal, nil
		}
		return equal, nil
	case "like", "not_like":
		actualText, actualOK := actual.(string)
		pattern, patternOK := when.Value.(string)
		if !actualOK || !patternOK {
			return false, nil
		}
		matched := like(actualText, pattern)
		if when.Op == "not_like" {
			return !matched, nil
		}
		return matched, nil
	default:
		return false, code("invalid_rules")
	}
}

func getField(row map[string]any, field string) (any, error) {
	if field == "url.host" {
		return hostOf(row["url"])
	}
	var current any = row
	for _, part := range strings.Split(field, ".") {
		parent, ok := current.(map[string]any)
		if !ok {
			return nil, nil
		}
		value, exists := parent[part]
		if !exists {
			return nil, nil
		}
		current = value
	}
	return current, nil
}

func setField(row map[string]any, field string, value any) error {
	if field == "url.host" {
		replacement, ok := value.(string)
		if !ok || replacement == "" {
			return code("invalid_host")
		}
		if err := validateHost(replacement); err != nil {
			return err
		}
		parsed, err := url.Parse(stringValue(row["url"]))
		if err != nil || parsed.Host == "" {
			return code("invalid_url")
		}
		parsed.Host = replacement
		row["url"] = parsed.String()
		return nil
	}
	parts := strings.Split(field, ".")
	parent := row
	for _, part := range parts[:len(parts)-1] {
		current, exists := parent[part]
		if !exists || current == nil {
			next := map[string]any{}
			parent[part] = next
			parent = next
			continue
		}
		next, ok := current.(map[string]any)
		if !ok {
			return code("invalid_field")
		}
		parent = next
	}
	cloned, err := cloneAny(value)
	if err != nil {
		return err
	}
	parent[parts[len(parts)-1]] = cloned
	return nil
}

func hostOf(value any) (string, error) {
	parsed, err := url.Parse(stringValue(value))
	if err != nil || parsed.Host == "" {
		return "", code("invalid_url")
	}
	return parsed.Host, nil
}

func validateHost(value string) error {
	parsed, err := url.Parse("http://" + value)
	if err != nil || (parsed.Host != value && parsed.Hostname()+":80" != value) ||
		parsed.User != nil || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return code("invalid_host")
	}
	return nil
}

func like(value, pattern string) bool {
	var expression strings.Builder
	expression.WriteByte('^')
	for _, char := range pattern {
		switch char {
		case '%':
			expression.WriteString(".*")
		case '_':
			expression.WriteByte('.')
		default:
			expression.WriteString(regexp.QuoteMeta(string(char)))
		}
	}
	expression.WriteByte('$')
	matched, err := regexp.MatchString(expression.String(), value)
	return err == nil && matched
}

func jsonEqual(left, right any) (bool, error) {
	a, err := json.Marshal(left)
	if err != nil {
		return false, err
	}
	b, err := json.Marshal(right)
	if err != nil {
		return false, err
	}
	return string(a) == string(b), nil
}

func cloneMap(value map[string]any) (map[string]any, error) {
	cloned, err := cloneAny(value)
	if err != nil {
		return nil, err
	}
	out, ok := cloned.(map[string]any)
	if !ok {
		return nil, code("invalid_rules")
	}
	return out, nil
}

func cloneAny(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	var out any
	if err := decoder.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func isString(value any) bool {
	_, ok := value.(string)
	return ok
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}
