import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn() }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn() }));
vi.mock("@/lib/utils/provider-schedule", () => ({ isProviderActiveNow: vi.fn() }));
vi.mock("@/lib/cache/provider-cache", () => ({ getProviderCacheStats: () => ({ version: 0 }) }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { getAvailableModelsGroupedByProviderType } from "@/app/v1/_lib/models/available-models";
import { computeCodexCatalog } from "@/lib/codex-catalog";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: 1,
    name: "p",
    providerType: "codex",
    url: "https://upstream.example.com",
    key: "k",
    allowedModels: ["gpt-6-sol"],
    providerPrefix: null,
    displayNameSuffix: null,
    isEnabled: true,
    activeTimeStart: null,
    activeTimeEnd: null,
    groupTag: null,
    allowedClients: [],
    blockedClients: [],
    ...overrides,
  } as unknown as Provider;
}

const auth = { user: { id: 1, providerGroup: null }, key: { providerGroup: null } };

describe("provider display-name suffix in model listings", () => {
  beforeEach(() => {
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
    vi.mocked(findAllProviders).mockResolvedValue([
      provider({
        id: 20,
        providerPrefix: "daily/",
        displayNameSuffix: "cyber",
        allowedModels: ["gpt-6-sol", "gpt-6-luna"],
      }),
      provider({ id: 8, allowedModels: ["gpt-6-sol"] }),
    ]);
  });

  it("marks the suffixed provider's models with `{model id} ({suffix})`", async () => {
    const { groups } = await getAvailableModelsGroupedByProviderType(auth, ["codex"]);
    const models = Object.fromEntries(groups[0].models.map((m) => [m.id, m.displayNameOverride]));
    expect(models).toEqual({
      "daily/gpt-6-luna": "gpt-6-luna (cyber)",
      "daily/gpt-6-sol": "gpt-6-sol (cyber)",
      "gpt-6-sol": undefined,
    });
  });

  it("shows the override in the Codex catalog and keeps other names", async () => {
    const { body } = await computeCodexCatalog(auth);
    const names = Object.fromEntries(
      (JSON.parse(body) as { models: { slug: string; display_name: string }[] }).models.map((m) => [
        m.slug,
        m.display_name,
      ])
    );
    expect(names).toEqual({
      "daily/gpt-6-sol": "gpt-6-sol (cyber)",
      "daily/gpt-6-luna": "gpt-6-luna (cyber)",
      "gpt-6-sol": "GPT-6-Sol",
    });
  });

  it("falls back to automatic disambiguation without a suffix", async () => {
    vi.mocked(findAllProviders).mockResolvedValue([
      provider({ id: 20, providerPrefix: "daily/" }),
      provider({ id: 8 }),
    ]);
    const { body } = await computeCodexCatalog(auth);
    const names = (JSON.parse(body) as { models: { display_name: string }[] }).models.map(
      (m) => m.display_name
    );
    expect(names.sort()).toEqual(["GPT-6-Sol", "GPT-6-Sol (daily)"]);
  });
});
