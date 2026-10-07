import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPrice, ModelPriceData } from "@/types/model-price";

const mocks = vi.hoisted(() => ({
  grouped: vi.fn(),
  batch: vi.fn(),
  cached: vi.fn(),
  settings: vi.fn(),
  vendors: vi.fn(),
}));

vi.mock("@/app/v1/_lib/models/available-models", () => ({
  getAvailableModelsGroupedByProviderType: mocks.grouped,
}));
vi.mock("@/repository/model-price", () => ({ findLatestPricesByModels: mocks.batch }));
vi.mock("@/lib/cache/model-price-cache", () => ({ findLatestPriceByModelCached: mocks.cached }));
vi.mock("@/lib/config/system-settings-cache", () => ({ getCachedSystemSettings: mocks.settings }));
vi.mock("@/repository/cloud-pricing-catalog", () => ({ getCloudPricingCatalog: mocks.vendors }));

import { buildModelCatalog } from "@/lib/model-catalog/build";
import { buildCatalogCacheKey, resetModelCatalogCacheForTests } from "@/lib/model-catalog/cache";

function price(modelName: string, priceData: ModelPriceData): ModelPrice {
  return {
    id: 1,
    modelName,
    priceData,
    source: "cloud",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const auth = {
  user: { id: 7, providerGroup: "default", allowedModels: [] as string[] },
  key: { providerGroup: null as string | null },
};

beforeEach(() => {
  resetModelCatalogCacheForTests();
  vi.clearAllMocks();
  mocks.grouped.mockResolvedValue({
    groups: [
      { providerType: "claude", models: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }] },
      { providerType: "codex", models: [{ id: "gpt-5" }] },
      { providerType: "openai-compatible", models: [{ id: "openai/gpt-5" }] },
      { providerType: "gemini-cli", models: [{ id: "gemini-2.5-pro", displayName: "Gemini" }] },
      { providerType: "mystery", models: [{ id: "ignored" }] },
    ],
  });
  mocks.batch.mockImplementation(async (names: string[]) => {
    const rows = new Map<string, ModelPrice>();
    if (names.includes("claude-sonnet-4-5")) {
      rows.set(
        "claude-sonnet-4-5",
        price("claude-sonnet-4-5", {
          display_name: "Claude Sonnet 4.5",
          vendor: "anthropic",
          input_cost_per_token: 0.000003,
          deprecated: true,
        })
      );
    }
    if (names.includes("gpt-5")) {
      rows.set("gpt-5", price("gpt-5", { vendor: "openai", output_cost_per_token: 0.00001 }));
    }
    return rows;
  });
  mocks.cached.mockImplementation(async (name: string) =>
    name === "gemini-2.5-pro"
      ? price("gemini-2.5-pro-alias", { vendor: "google", max_input_tokens: 1_048_576 })
      : null
  );
  mocks.settings.mockResolvedValue({ agentCatalogNotes: "  Prefer Sonnet.  " });
  mocks.vendors.mockResolvedValue({
    vendors: [
      { vendor: "anthropic", name: "Anthropic", icon: "anthropic.svg", iconMono: true },
      { vendor: "google", name: "Google", modelCount: 1 },
      { vendor: "", name: "skip" },
    ],
  });
});

describe("buildModelCatalog", () => {
  it("maps provider types to protocols with the strict matrix", async () => {
    const catalog = await buildModelCatalog(auth);
    const byId = new Map(catalog.models.map((model) => [model.id, model]));

    expect(catalog.models.map((model) => model.id)).toEqual([
      "claude-sonnet-4-5",
      "gemini-2.5-pro",
      "gpt-5",
      "openai/gpt-5",
    ]);
    expect(byId.get("gpt-5")?.protocols).toEqual(["claude", "response"]);
    expect(byId.get("openai/gpt-5")?.protocols).toEqual(["openai"]);
    expect(byId.get("gemini-2.5-pro")?.protocols).toEqual(["gemini-cli"]);

    const protocols = Object.fromEntries(catalog.protocols.map((p) => [p.id, p.models]));
    expect(protocols).toEqual({
      claude: ["claude-sonnet-4-5", "gpt-5"],
      response: ["gpt-5"],
      openai: ["openai/gpt-5"],
      gemini: [],
      "gemini-cli": ["gemini-2.5-pro"],
    });
    expect(mocks.grouped).toHaveBeenCalledWith(auth, [
      "claude",
      "claude-auth",
      "codex",
      "openai-compatible",
      "gemini",
      "gemini-cli",
    ]);
  });

  it("joins prices by exact name, fallback candidate and alias lookup", async () => {
    const catalog = await buildModelCatalog(auth);
    const byId = new Map(catalog.models.map((model) => [model.id, model]));

    expect(byId.get("claude-sonnet-4-5")).toMatchObject({
      displayName: "Claude Sonnet 4.5",
      vendor: "anthropic",
      vendorName: "Anthropic",
      vendorIcon: "anthropic.svg",
      vendorIconMono: true,
      deprecated: true,
      hasPriceData: true,
    });
    expect(byId.get("claude-sonnet-4-5")?.pricing?.input).toBe(3);
    // "openai/gpt-5" resolves through the stripped candidate "gpt-5"
    expect(byId.get("openai/gpt-5")?.pricing?.output).toBe(10);
    expect(byId.get("openai/gpt-5")?.vendorName).toBe("OpenAI");
    // alias lookup via the cached single-model query
    expect(byId.get("gemini-2.5-pro")).toMatchObject({
      contextWindow: 1_048_576,
      vendorName: "Google",
      displayName: "Gemini",
    });
    expect(mocks.cached).toHaveBeenCalledWith("gemini-2.5-pro");
  });

  it("returns nulls for models without any price row", async () => {
    mocks.grouped.mockResolvedValue({
      groups: [{ providerType: "claude", models: [{ id: "claude-unknown-9" }] }],
    });
    const catalog = await buildModelCatalog(auth);
    expect(catalog.models[0]).toMatchObject({
      id: "claude-unknown-9",
      vendor: "anthropic",
      vendorName: "Anthropic",
      pricing: null,
      capabilities: null,
      hasPriceData: false,
    });
  });

  it("caches per group and allowed models, but reads notes on every call", async () => {
    const first = await buildModelCatalog(auth);
    mocks.settings.mockResolvedValue({ agentCatalogNotes: "updated" });
    const second = await buildModelCatalog(auth);

    expect(mocks.grouped).toHaveBeenCalledTimes(1);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(first.notes).toBe("Prefer Sonnet.");
    expect(second.notes).toBe("updated");

    await buildModelCatalog({ ...auth, key: { providerGroup: "vip" } });
    await buildModelCatalog({ ...auth, user: { ...auth.user, allowedModels: ["gpt-5"] } });
    expect(mocks.grouped).toHaveBeenCalledTimes(3);
  });

  it("builds once for concurrent requests sharing a key", async () => {
    await Promise.all([buildModelCatalog(auth), buildModelCatalog(auth)]);
    expect(mocks.grouped).toHaveBeenCalledTimes(1);
  });

  it("treats blank notes and settings errors as no notes", async () => {
    mocks.settings.mockResolvedValueOnce({ agentCatalogNotes: "   " });
    expect((await buildModelCatalog(auth)).notes).toBeNull();
    mocks.settings.mockRejectedValueOnce(new Error("db down"));
    expect((await buildModelCatalog(auth)).notes).toBeNull();
  });

  it("survives a missing vendor directory", async () => {
    mocks.vendors.mockRejectedValue(new Error("no table"));
    const catalog = await buildModelCatalog(auth);
    const sonnet = catalog.models.find((model) => model.id === "claude-sonnet-4-5");
    // falls back to the built-in display name and drops the directory icon
    expect(sonnet?.vendorName).toBe("Anthropic");
    expect(sonnet?.vendorIcon).toBeNull();
  });

  it("does not cache a failed build", async () => {
    mocks.grouped.mockRejectedValueOnce(new Error("boom"));
    await expect(buildModelCatalog(auth)).rejects.toThrow("boom");
    await expect(buildModelCatalog(auth)).resolves.toBeTruthy();
  });
});

describe("buildCatalogCacheKey", () => {
  it("uses key group over user group and normalizes allowed models", () => {
    expect(
      buildCatalogCacheKey({
        user: { id: 1, providerGroup: "a", allowedModels: ["GPT-5", " claude ", "gpt-5", ""] },
        key: { providerGroup: "b" },
      })
    ).toBe("b|claude,gpt-5");
    expect(
      buildCatalogCacheKey({ user: { id: 1, providerGroup: null }, key: { providerGroup: null } })
    ).toBe("|");
  });
});
