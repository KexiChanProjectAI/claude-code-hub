import { describe, expect, it } from "vitest";
import {
  applyOpenRouterProviderRouting,
  hasOpenRouterProviderRouting,
  normalizeOpenRouterProviderRouting,
  OPENROUTER_PROVIDER_LIST_MAX_ITEMS,
  OPENROUTER_PROVIDER_ROUTING_SCHEMA,
  supportsOpenRouterProviderRouting,
} from "@/lib/openrouter/provider-routing";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";

describe("normalizeOpenRouterProviderRouting", () => {
  it("returns null for non-objects and empty configs", () => {
    expect(normalizeOpenRouterProviderRouting(null)).toBeNull();
    expect(normalizeOpenRouterProviderRouting(undefined)).toBeNull();
    expect(normalizeOpenRouterProviderRouting("x")).toBeNull();
    expect(normalizeOpenRouterProviderRouting([])).toBeNull();
    expect(normalizeOpenRouterProviderRouting({})).toBeNull();
    expect(
      normalizeOpenRouterProviderRouting({ order: [], quantizations: [], max_price: {} })
    ).toBeNull();
  });

  it("keeps every supported key in wire format", () => {
    const input = {
      order: ["deepinfra", "together"],
      only: ["anthropic"],
      ignore: ["novita"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      enforce_distillable_text: false,
      quantizations: ["fp16", "bf16"],
      sort: "price",
      max_price: { prompt: 1, completion: 2.5, request: 0, image: 0.01 },
      preferred_min_throughput: 50,
      preferred_max_latency: 3,
    };
    expect(normalizeOpenRouterProviderRouting(input)).toEqual(input);
  });

  it("trims, dedupes (case-insensitive) and caps provider lists", () => {
    const many = Array.from({ length: OPENROUTER_PROVIDER_LIST_MAX_ITEMS + 5 }, (_, i) => `p${i}`);
    const result = normalizeOpenRouterProviderRouting({
      order: [" DeepInfra ", "deepinfra", "", 3, "together"],
      only: many,
    });
    expect(result?.order).toEqual(["DeepInfra", "together"]);
    expect(result?.only).toHaveLength(OPENROUTER_PROVIDER_LIST_MAX_ITEMS);
  });

  it("drops invalid values and orders quantizations canonically", () => {
    expect(
      normalizeOpenRouterProviderRouting({
        sort: "cheapest",
        data_collection: "maybe",
        zdr: "yes",
        quantizations: ["bf16", "fp99", "int4"],
        max_price: { prompt: -1, completion: Number.NaN, request: "1", image: 2 },
        preferred_min_throughput: -5,
        preferred_max_latency: Number.POSITIVE_INFINITY,
        unknown_key: 1,
      })
    ).toEqual({ quantizations: ["int4", "bf16"], max_price: { image: 2 } });
  });
});

describe("OPENROUTER_PROVIDER_ROUTING_SCHEMA", () => {
  it("passes undefined through and normalizes objects", () => {
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.parse(undefined)).toBeUndefined();
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.parse(null)).toBeNull();
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.parse({})).toBeNull();
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.parse({ zdr: true, order: [" a "] })).toEqual({
      zdr: true,
      order: ["a"],
    });
  });

  it("rejects unknown keys and invalid enum values", () => {
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.safeParse({ foo: 1 }).success).toBe(false);
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.safeParse({ sort: "cheap" }).success).toBe(false);
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.safeParse({ quantizations: ["fp99"] }).success).toBe(
      false
    );
    expect(
      OPENROUTER_PROVIDER_ROUTING_SCHEMA.safeParse({ max_price: { prompt: -1 } }).success
    ).toBe(false);
    expect(OPENROUTER_PROVIDER_ROUTING_SCHEMA.safeParse({ max_price: { tokens: 1 } }).success).toBe(
      false
    );
  });

  it("is wired into create and update provider schemas", () => {
    const created = CreateProviderSchema.parse({
      name: "openrouter",
      url: "https://openrouter.ai/api/v1",
      key: "sk-or-test",
      openrouter_provider_routing: { sort: "throughput", zdr: true },
    });
    expect(created.openrouter_provider_routing).toEqual({ sort: "throughput", zdr: true });

    expect(UpdateProviderSchema.parse({ openrouter_provider_routing: null })).toMatchObject({
      openrouter_provider_routing: null,
    });
    expect(
      UpdateProviderSchema.safeParse({ openrouter_provider_routing: { sort: "bad" } }).success
    ).toBe(false);
  });
});

describe("supportsOpenRouterProviderRouting / hasOpenRouterProviderRouting", () => {
  it("excludes gemini provider types", () => {
    expect(supportsOpenRouterProviderRouting("claude")).toBe(true);
    expect(supportsOpenRouterProviderRouting("openai-compatible")).toBe(true);
    expect(supportsOpenRouterProviderRouting("gemini")).toBe(false);
    expect(supportsOpenRouterProviderRouting("gemini-cli")).toBe(false);
  });

  it("requires a non-empty config on a supported type", () => {
    expect(
      hasOpenRouterProviderRouting({
        providerType: "openai-compatible",
        openrouterProviderRouting: { zdr: true },
      })
    ).toBe(true);
    expect(
      hasOpenRouterProviderRouting({
        providerType: "openai-compatible",
        openrouterProviderRouting: {},
      })
    ).toBe(false);
    expect(
      hasOpenRouterProviderRouting({
        providerType: "gemini",
        openrouterProviderRouting: { zdr: true },
      })
    ).toBe(false);
  });
});

describe("applyOpenRouterProviderRouting", () => {
  const provider = {
    id: 7,
    name: "OpenRouter",
    providerType: "openai-compatible",
    openrouterProviderRouting: {
      quantizations: ["fp16", "bf16"],
      sort: "price",
      max_price: { prompt: 1 },
    },
  } as const;

  it("returns the same request when nothing is configured", () => {
    const request = { model: "x" };
    const result = applyOpenRouterProviderRouting(
      { providerType: "openai-compatible", openrouterProviderRouting: null },
      request
    );
    expect(result.request).toBe(request);
    expect(result.audit).toBeNull();
  });

  it("skips gemini providers", () => {
    const request = { contents: [] };
    const result = applyOpenRouterProviderRouting(
      { providerType: "gemini", openrouterProviderRouting: { zdr: true } },
      request
    );
    expect(result.request).toBe(request);
    expect(result.audit).toBeNull();
  });

  it("injects the provider field without mutating the input", () => {
    const request = { model: "deepseek/deepseek-chat", messages: [] };
    const result = applyOpenRouterProviderRouting(provider, request);

    expect(request).not.toHaveProperty("provider");
    expect(result.request).toEqual({
      model: "deepseek/deepseek-chat",
      messages: [],
      provider: { quantizations: ["fp16", "bf16"], sort: "price", max_price: { prompt: 1 } },
    });
    expect(result.audit).toMatchObject({
      type: "provider_parameter_override",
      scope: "provider",
      providerId: 7,
      providerName: "OpenRouter",
      providerType: "openai-compatible",
      hit: true,
      changed: true,
      changes: [{ path: "provider", before: null, changed: true }],
    });
  });

  it("merges with client keys; configured keys win and max_price merges per key", () => {
    const request = {
      provider: { sort: "latency", order: ["groq"], max_price: { prompt: 5, completion: 9 } },
    };
    const result = applyOpenRouterProviderRouting(provider, request);
    expect(result.request.provider).toEqual({
      sort: "price",
      order: ["groq"],
      quantizations: ["fp16", "bf16"],
      max_price: { prompt: 1, completion: 9 },
    });
    expect(result.audit?.changes[0].before).toBe(JSON.stringify(request.provider));
  });

  it("reports changed=false when the client already sent the same preferences", () => {
    const request = {
      provider: { quantizations: ["fp16", "bf16"], sort: "price", max_price: { prompt: 1 } },
    };
    const result = applyOpenRouterProviderRouting(provider, request);
    expect(result.audit?.changed).toBe(false);
  });

  it("replaces a non-object client provider field", () => {
    const result = applyOpenRouterProviderRouting(provider, { provider: "openai" });
    expect(result.request.provider).toEqual(provider.openrouterProviderRouting);
    expect(result.audit?.changes[0].before).toBeNull();
  });
});
