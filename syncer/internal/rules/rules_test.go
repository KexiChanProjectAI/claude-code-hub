package rules

import "testing"

func TestTargetOverridesKeepLocalDirectAndExternalProxy(t *testing.T) {
	rules := append(TargetOverrides("local-key", "http://user:secret@127.0.0.1:5354"), Rule{
		Tables: []string{"providers"},
		Set:    map[string]any{"proxy_fallback_to_direct": false},
	})
	local, err := Apply("providers", map[string]any{
		"url": "http://127.0.0.1:52841/v1", "key": "source-key",
		"proxy_url": "http://10.0.0.1:5354", "proxy_fallback_to_direct": true,
	}, rules)
	if err != nil {
		t.Fatal(err)
	}
	if local["key"] != "local-key" || local["proxy_url"] != nil || local["proxy_fallback_to_direct"] != false {
		t.Fatalf("local override = %#v", local)
	}
	external, err := Apply("providers", map[string]any{
		"url": "https://api.example/v1", "key": "upstream-key",
		"proxy_url": "http://source-proxy", "proxy_fallback_to_direct": true,
	}, rules)
	if err != nil {
		t.Fatal(err)
	}
	if external["key"] != "upstream-key" || external["proxy_url"] != "http://user:secret@127.0.0.1:5354" ||
		external["proxy_fallback_to_direct"] != false {
		t.Fatalf("external override = %#v", external)
	}
}

func TestFallbackRuleWinsOverEarlierTrue(t *testing.T) {
	row, err := Apply("providers", map[string]any{"url": "https://api.example", "proxy_fallback_to_direct": false}, []Rule{
		{Tables: []string{"providers"}, Set: map[string]any{"proxy_fallback_to_direct": true}},
		{Tables: []string{"providers"}, Set: map[string]any{"proxy_fallback_to_direct": false}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if row["proxy_fallback_to_direct"] != false {
		t.Fatal("earlier rule re-enabled direct fallback")
	}
}

func TestPolicyRejectsUnknownField(t *testing.T) {
	if _, err := ParsePolicy([]byte(`{"preserveProviders":["cc官key"],"other":true}`)); err == nil || err.Error() != "invalid_policy" {
		t.Fatalf("error = %v", err)
	}
	policy, err := ParsePolicy([]byte(`{"preserveProviders":["cc官key","cc官key","openai 官key"],"rules":[{"tables":["providers"],"set":{"proxy_fallback_to_direct":false}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(policy.PreserveProviders) != 2 || len(policy.Rules) != 1 {
		t.Fatalf("policy = %#v", policy)
	}
}
