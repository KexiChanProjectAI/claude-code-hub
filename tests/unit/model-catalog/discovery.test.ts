import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelCatalog: vi.fn(), resolvePrices: vi.fn() }));

vi.mock("@/lib/model-catalog/price-join", () => ({ resolvePricesForModels: mocks.resolvePrices }));

vi.mock("@/lib/model-catalog/build", () => ({ buildModelCatalog: mocks.buildModelCatalog }));
vi.mock("@/repository/key", () => ({ resolveApiKeyAuthOutcome: vi.fn() }));
vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn() }));
vi.mock("@/lib/utils/provider-schedule", () => ({ isProviderActiveNow: vi.fn() }));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({ checkProviderGroupMatch: vi.fn() }));
vi.mock("@/lib/cache/provider-cache", () => ({ getProviderCacheStats: () => ({ version: 0 }) }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn().mockResolvedValue("en") }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { handleAvailableModels } from "@/app/v1/_lib/models/available-models";
import { PROTOCOL_HINT_HEADER } from "@/app/v1/_lib/unprefixed-v1-alias";
import { loadBuiltinTemplates } from "@/lib/codex-catalog/templates";
import {
  bareModelName,
  buildProtocolModelList,
  limitDonorCandidates,
  resolveBorrowedLimits,
  toDiscoveryRow,
} from "@/lib/model-catalog/discovery";
import type { CatalogModel } from "@/lib/model-catalog/types";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { findAllProviders } from "@/repository/provider";

function model(overrides: Partial<CatalogModel>): CatalogModel {
  const id = overrides.id ?? "m";
  return {
    id,
    displayName: id,
    vendor: null,
    vendorName: null,
    vendorIcon: null,
    vendorIconMono: false,
    protocols: ["openai"],
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    capabilities: null,
    modalities: null,
    knowledgeCutoff: null,
    deprecated: false,
    hasPriceData: false,
    ...overrides,
  };
}

const capabilities = (reasoning: boolean, vision = false) => ({
  vision,
  functionCalling: true,
  reasoning,
  pdfInput: false,
  promptCaching: false,
});

const templates = loadBuiltinTemplates();

describe("toDiscoveryRow", () => {
  it("emits every known field from the price table", () => {
    const row = toDiscoveryRow(
      model({
        id: "acme-sonnet",
        displayName: "Acme Sonnet",
        vendor: "acme",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        modalities: { input: ["text", "image"], output: ["text"] },
        capabilities: capabilities(true, true),
        hasPriceData: true,
      }),
      templates,
      1
    );
    expect(row).toEqual({
      id: "acme-sonnet",
      object: "model",
      created: 1,
      owned_by: "acme",
      metadata: { display_name: "Acme Sonnet" },
      context_length: 200000,
      max_output_tokens: 64000,
      limits: { max_output_tokens: 64000 },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supported_reasoning_levels: ["low", "medium", "high"],
      default_reasoning_level: "medium",
    });
  });

  it("declares reasoning false for priced non-reasoning models", () => {
    const row = toDiscoveryRow(
      model({ id: "acme-fast", hasPriceData: true, capabilities: capabilities(false) }),
      templates,
      1
    );
    expect(row.reasoning).toBe(false);
    expect(row.supported_reasoning_levels).toBeUndefined();
  });

  it("omits unknown fields instead of guessing", () => {
    const row = toDiscoveryRow(model({ id: "claude-opus-4-8", vendor: "anthropic" }), templates, 1);
    expect(row).toEqual({
      id: "claude-opus-4-8",
      object: "model",
      created: 1,
      owned_by: "anthropic",
      metadata: { display_name: "claude-opus-4-8" },
    });
  });

  it("caps max output at the context length", () => {
    const row = toDiscoveryRow(
      model({ contextWindow: 1000, maxOutputTokens: 5000, hasPriceData: true }),
      templates,
      1
    );
    expect(row.max_output_tokens).toBe(1000);
  });

  it("uses curated templates for capabilities and filters unknown levels", () => {
    const sol = toDiscoveryRow(model({ id: "openai/gpt-6.1-sol" }), templates, 1);
    expect(sol.metadata.display_name).toBe("GPT-6.1-Sol");
    expect(sol.context_length).toBe(272000);
    expect(sol.input_modalities).toEqual(["text", "image"]);
    expect(sol.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(sol.default_reasoning_level).toBe("low");
  });

  it("maps DeepSeek models by capability, price limits first", () => {
    const flash = toDiscoveryRow(
      model({
        id: "openrouter/deepseek/deepseek-v4.1-flash",
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        // The price row may lag behind; the curated template decides image input.
        modalities: { input: ["text"], output: ["text"] },
        capabilities: capabilities(true),
        hasPriceData: true,
      }),
      templates,
      1
    );
    expect(flash).toMatchObject({
      context_length: 1048576,
      max_output_tokens: 65536,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: ["low", "high", "max"],
      default_reasoning_level: "high",
    });

    const chat = toDiscoveryRow(model({ id: "deepseek-chat" }), templates, 1);
    expect(chat).toMatchObject({
      context_length: 131072,
      input_modalities: ["text"],
      reasoning: false,
    });
    expect(chat.supported_reasoning_levels).toBeUndefined();
  });

  it("does not borrow metadata from the generic fallback template", () => {
    const row = toDiscoveryRow(model({ id: "minimax/MiniMax-M3" }), templates, 1);
    expect(row.context_length).toBeUndefined();
    expect(row.input_modalities).toBeUndefined();
    expect(row.supported_reasoning_levels).toBeUndefined();
    expect(row.owned_by).toBeTypeOf("string");
  });
});

describe("buildProtocolModelList", () => {
  beforeEach(() => {
    mocks.buildModelCatalog.mockResolvedValue({
      generatedAt: "x",
      notes: null,
      protocols: [],
      models: [
        model({ id: "claude-x", protocols: ["claude"] }),
        model({ id: "gpt-x", protocols: ["openai", "response"] }),
        model({ id: "codex-only", protocols: ["response"] }),
      ],
    });
  });

  it.each([
    ["claude", ["claude-x"]],
    ["openai", ["gpt-x"]],
    ["response", ["gpt-x", "codex-only"]],
  ] as const)("lists only %s models", async (protocol, ids) => {
    const list = await buildProtocolModelList(
      { user: { id: 1, providerGroup: null }, key: { providerGroup: null } },
      protocol
    );
    expect(list.object).toBe("list");
    expect(list.data.map((row) => row.id)).toEqual(ids);
  });
});

describe("/v1/models with a protocol hint", () => {
  beforeEach(() => {
    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValue({
      ok: true,
      user: { id: 1, providerGroup: null, isEnabled: true, expiresAt: null },
      key: { providerGroup: null, name: "k" },
    } as never);
    vi.mocked(findAllProviders).mockResolvedValue([]);
    mocks.buildModelCatalog.mockResolvedValue({
      generatedAt: "x",
      notes: null,
      protocols: [],
      models: [model({ id: "claude-x", protocols: ["claude"] })],
    });
  });

  function request(path: string, headers: Record<string, string>) {
    const app = new Hono();
    app.get("/v1/models", handleAvailableModels);
    app.get("/v1/models/catalog", handleAvailableModels);
    return app.request(`http://localhost${path}`, {
      headers: { authorization: "Bearer sk", ...headers },
    });
  }

  it("returns the per-protocol discovery list", async () => {
    const response = await request("/v1/models", { [PROTOCOL_HINT_HEADER]: "claude" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("list");
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(["claude-x"]);
    expect(body.data[0].metadata).toEqual({ display_name: "claude-x" });
  });

  it("wins over the Codex client_version probe", async () => {
    const response = await request("/v1/models?client_version=0.153.0", {
      [PROTOCOL_HINT_HEADER]: "response",
    });
    expect((await response.json()).object).toBe("list");
  });

  it("ignores unknown hints and other paths", async () => {
    const response = await request("/v1/models", { [PROTOCOL_HINT_HEADER]: "gemini" });
    expect(response.status).toBe(200);
    expect(mocks.buildModelCatalog).not.toHaveBeenCalled();
  });

  it("still requires authentication", async () => {
    const app = new Hono();
    app.get("/v1/models", handleAvailableModels);
    const response = await app.request("http://localhost/v1/models", {
      headers: { [PROTOCOL_HINT_HEADER]: "claude" },
    });
    expect(response.status).toBe(401);
  });
});

describe("borrowed output limits for aliases", () => {
  const priceRow = (maxInput: number, maxOutput: number) => ({
    priceData: { max_input_tokens: maxInput, max_output_tokens: maxOutput, mode: "chat" },
  });

  beforeEach(() => {
    mocks.resolvePrices.mockReset();
  });

  it("strips namespaces and gateway suffixes", () => {
    expect(bareModelName("openrouter/anthropic/deepseek/deepseek-v4.1-flash-1017[1m]")).toBe(
      "deepseek-v4.1-flash-1017"
    );
    expect(bareModelName("deepseek-flash-cyber")).toBe("deepseek-flash-cyber");
  });

  it("lists donors: bare alias first, then the matched template slug", () => {
    expect(limitDonorCandidates(model({ id: "deepseek-flash-cyber" }), templates)).toEqual([
      "deepseek-flash",
    ]);
    expect(
      limitDonorCandidates(
        model({ id: "openrouter/anthropic/deepseek/deepseek-v4.1-flash-1017[1m]" }),
        templates
      )
    ).toEqual(["deepseek-v4.1-flash-1017", "deepseek-flash"]);
    expect(limitDonorCandidates(model({ id: "deepseek-v4-pro-cyber" }), templates)).toEqual([
      "deepseek-v4-pro",
    ]);
  });

  it("does not borrow for priced models, older DeepSeek generations or unmatched models", () => {
    expect(
      limitDonorCandidates(model({ id: "deepseek-flash-cyber", maxOutputTokens: 8192 }), templates)
    ).toEqual([]);
    expect(limitDonorCandidates(model({ id: "deepseek-chat" }), templates)).toEqual([]);
    expect(
      limitDonorCandidates(model({ id: "openrouter/deepseek/deepseek-r1" }), templates)
    ).toEqual([]);
    expect(limitDonorCandidates(model({ id: "minimax/MiniMax-M3" }), templates)).toEqual([]);
  });

  it("takes the first donor that has an output limit", async () => {
    mocks.resolvePrices.mockResolvedValue(
      new Map<string, unknown>([
        ["deepseek-v4.1-flash-1017", priceRow(262144, 262144)],
        ["deepseek-flash", priceRow(1048576, 393216)],
      ])
    );
    const borrowed = await resolveBorrowedLimits(
      [
        model({ id: "openrouter/anthropic/deepseek/deepseek-v4.1-flash-1017[1m]" }),
        model({ id: "deepseek-flash-cyber" }),
        model({ id: "minimax/MiniMax-M3" }),
      ],
      templates
    );
    expect(borrowed.get("openrouter/anthropic/deepseek/deepseek-v4.1-flash-1017[1m]")).toEqual({
      contextWindow: 262144,
      maxOutputTokens: 262144,
    });
    expect(borrowed.get("deepseek-flash-cyber")).toEqual({
      contextWindow: 1048576,
      maxOutputTokens: 393216,
    });
    expect(borrowed.has("minimax/MiniMax-M3")).toBe(false);
    expect(mocks.resolvePrices).toHaveBeenCalledTimes(1);
  });

  it("borrows nothing when the price lookup fails or nothing is needed", async () => {
    mocks.resolvePrices.mockRejectedValue(new Error("db down"));
    expect(
      (await resolveBorrowedLimits([model({ id: "deepseek-flash-cyber" })], templates)).size
    ).toBe(0);
    expect((await resolveBorrowedLimits([model({ id: "minimax/x" })], templates)).size).toBe(0);
  });

  it("emits borrowed limits, capped by the context length", () => {
    const row = toDiscoveryRow(model({ id: "deepseek-flash-cyber" }), templates, 1, {
      contextWindow: 1048576,
      maxOutputTokens: 393216,
    });
    expect(row).toMatchObject({
      context_length: 1048576,
      max_output_tokens: 393216,
      limits: { max_output_tokens: 393216 },
    });
    const capped = toDiscoveryRow(model({ id: "x", contextWindow: 1000 }), templates, 1, {
      contextWindow: null,
      maxOutputTokens: 5000,
    });
    expect(capped.max_output_tokens).toBe(1000);
  });

  it("applies borrowed limits in the protocol list", async () => {
    mocks.buildModelCatalog.mockResolvedValue({
      generatedAt: "x",
      notes: null,
      protocols: [],
      models: [model({ id: "deepseek-flash-cyber", protocols: ["claude"] })],
    });
    mocks.resolvePrices.mockResolvedValue(
      new Map<string, unknown>([["deepseek-flash", priceRow(1048576, 393216)]])
    );
    const list = await buildProtocolModelList(
      { user: { id: 1, providerGroup: null }, key: { providerGroup: null } },
      "claude"
    );
    expect(list.data[0]).toMatchObject({ id: "deepseek-flash-cyber", max_output_tokens: 393216 });
  });
});
