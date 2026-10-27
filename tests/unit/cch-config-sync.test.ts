import { describe, expect, test } from "vitest";
import { applyRules, parsePolicy, parseRules } from "../../scripts/sync-cch-config";

const rule = (op: "eq" | "ne" | "like" | "not_like", value: unknown) =>
  parseRules([
    {
      tables: ["providers"],
      when: { field: "url.host", op, value },
      set: { proxy_url: "socks5://localhost:1080" },
    },
  ]);

describe("CCH configuration rewrite rules", () => {
  test("rewrites provider and endpoint hosts, removes the old port, and preserves URL components", () => {
    const rules = parseRules([
      {
        tables: ["providers", "provider_endpoints"],
        when: { field: "url.host", op: "eq", value: "old.example:8443" },
        set: { "url.host": "new.example" },
      },
    ]);
    const original = {
      url: "https://user:secret@old.example:8443/v1?x=1#fragment",
      key: "private",
      custom_headers: { token: "secret" },
    };
    for (const table of ["providers", "provider_endpoints"] as const) {
      expect(applyRules(table, original, rules)).toEqual({
        ...original,
        url: "https://user:secret@new.example/v1?x=1#fragment",
      });
    }
    expect(original.url).toContain("old.example:8443");
    expect(applyRules("model_prices", original, rules)).toEqual(original);
  });

  test.each([
    ["eq", "api.example", true],
    ["eq", "other.example", false],
    ["ne", "api.example", false],
    ["ne", "other.example", true],
    ["like", "api.%", true],
    ["like", "apiX%", false],
    ["not_like", "api.%", false],
    ["not_like", "internal%", true],
    ["like", "_pi.example", true],
    ["like", "api.example%", true],
    ["like", "[api].%", false],
  ] as const)("%s %s matches=%s", (op, pattern, expected) => {
    expect(
      applyRules("providers", { url: "https://api.example/v1" }, rule(op, pattern)).proxy_url
    ).toBe(expected ? "socks5://localhost:1080" : undefined);
  });

  test("uses sequential rewritten values and preserves unrelated JSON fields", () => {
    const rules = parseRules([
      { tables: ["providers"], set: { "url.host": "internal.example:9443" } },
      {
        tables: ["providers"],
        when: { field: "url.host", op: "not_like", value: "internal%" },
        set: { proxy_url: "wrong" },
      },
      {
        tables: ["providers"],
        when: { field: "is_enabled", op: "eq", value: false },
        set: { proxy_url: null, "custom_headers.token": "changed" },
      },
    ]);
    const original = {
      url: "https://external.example/v1",
      is_enabled: false,
      custom_headers: { token: "old", other: "keep" },
    };
    expect(applyRules("providers", original, rules)).toEqual({
      url: "https://internal.example:9443/v1",
      is_enabled: false,
      proxy_url: null,
      custom_headers: { token: "changed", other: "keep" },
    });
    expect(original.custom_headers.token).toBe("old");
  });

  test("creates nullable JSON objects but rejects traversal through scalars and arrays", () => {
    const rules = parseRules([
      { tables: ["model_prices"], set: { "price_data.input_cost_per_token": 0.01 } },
    ]);
    expect(applyRules("model_prices", { price_data: null }, rules)).toEqual({
      price_data: { input_cost_per_token: 0.01 },
    });
    for (const price_data of [5, []])
      expect(() => applyRules("model_prices", { price_data }, rules)).toThrow("invalid_field");
  });

  test("LIKE and NOT LIKE do not match NULL or missing nested fields", () => {
    for (const op of ["like", "not_like"] as const) {
      const rules = parseRules([
        {
          tables: ["providers"],
          when: { field: "custom_headers.region", op, value: "%" },
          set: { weight: 9 },
        },
      ]);
      for (const custom_headers of [null, {}, { region: null }, { region: 3 }]) {
        expect(applyRules("providers", { custom_headers, weight: 1 }, rules).weight).toBe(1);
      }
    }
  });

  test.each([
    null,
    {},
    [null],
    [[]],
    [{ tables: [], set: { weight: 1 } }],
    [{ tables: ["users"], set: { weight: 1 } }],
    [{ tables: ["providers"], set: {} }],
    [{ tables: ["providers"], set: [] }],
    [{ tables: ["providers"], set: { weight: 1 }, typo: true }],
    [
      {
        tables: ["providers"],
        when: { field: "weight", op: "contains", value: 1 },
        set: { weight: 1 },
      },
    ],
    [{ tables: ["providers"], when: { field: "weight", op: "eq" }, set: { weight: 1 } }],
    [{ tables: ["providers"], when: null, set: { weight: 1 } }],
    [
      {
        tables: ["providers"],
        when: { field: "weight", op: "like", value: 1 },
        set: { weight: 1 },
      },
    ],
  ])("rejects malformed rules: %j", (value) => {
    expect(() => parseRules(value)).toThrow("invalid_rules");
  });

  test.each([
    "id",
    "vendor_id",
    "provider_vendor_id",
    "created_at",
    "last_probe_ok",
    "custom_headers.__proto__.polluted",
    "custom_headers.constructor",
    "custom_headers..token",
  ])("rejects protected field %s", (field) => {
    expect(() => parseRules([{ tables: ["providers"], set: { [field]: 1 } }])).toThrow(
      "invalid_field"
    );
    expect({}).not.toHaveProperty("polluted");
  });

  test.each([
    "",
    null,
    1,
    "https://api.example",
    "api.example/path",
    "user@api.example",
    "api.example?x=1",
  ])("rejects invalid replacement host %j", (host) => {
    const rules = parseRules([{ tables: ["providers"], set: { "url.host": host } }]);
    expect(() => applyRules("providers", { url: "https://old.example" }, rules)).toThrow();
  });

  test("accepts IPv6 and does not reuse mutable rule payloads", () => {
    const rules = parseRules([
      { tables: ["providers"], set: { "url.host": "[::1]:9000", allowed_models: ["model"] } },
    ]);
    const result = applyRules("providers", { url: "https://old.example/v1" }, rules);
    expect(result.url).toBe("https://[::1]:9000/v1");
    (result.allowed_models as string[]).push("extra");
    expect(rules[0].set.allowed_models).toEqual(["model"]);
  });
});

test.each([80, 443, 9443])("preserves explicit replacement port %s with an HTTP source", (port) => {
  const rules = parseRules([{ tables: ["providers"], set: { "url.host": `new.example:${port}` } }]);
  const result = applyRules("providers", { url: "http://old.example:8080/v1" }, rules);
  expect(result.url).toBe(`http://new.example${port === 80 ? "" : `:${port}`}/v1`);
});

describe("configuration preservation policy", () => {
  test("preserves exact names and rejects malformed policy input", () => {
    expect(parsePolicy({ preserveProviders: ["cc官key", "openai 官key", "cc官key"] })).toEqual({
      preserveProviders: ["cc官key", "openai 官key"],
      rules: [],
    });
    expect(parsePolicy({})).toEqual({ preserveProviders: [], rules: [] });
    for (const value of [
      null,
      [],
      "policy",
      { typo: [] },
      { preserveProviders: "name" },
      { preserveProviders: null },
      { preserveProviders: [null] },
      { preserveProviders: [" "] },
    ]) {
      expect(() => parsePolicy(value)).toThrow("invalid_policy");
    }
  });

  test("last policy rule forbids fallback even when a preceding rule enables it", () => {
    const policy = parsePolicy({
      preserveProviders: [],
      rules: [{ tables: ["providers"], set: { proxy_fallback_to_direct: false } }],
    });
    const rules = parseRules([{ tables: ["providers"], set: { proxy_fallback_to_direct: true } }]);
    expect(
      applyRules("providers", { proxy_fallback_to_direct: true }, [...rules, ...policy.rules])
        .proxy_fallback_to_direct
    ).toBe(false);
    expect(() => parsePolicy({ rules: null })).toThrow("invalid_rules");
    expect(() => parsePolicy({ rules: [{ tables: ["users"], set: { value: 1 } }] })).toThrow(
      "invalid_rules"
    );
  });
});
