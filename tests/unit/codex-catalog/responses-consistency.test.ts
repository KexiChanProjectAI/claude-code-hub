import { describe, expect, it, vi } from "vitest";

vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn() }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn().mockResolvedValue("UTC"),
}));
vi.mock("@/lib/utils/provider-schedule", () => ({
  isProviderActiveNow: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/cache/provider-cache", () => ({
  getProviderCacheStats: () => ({ version: 0 }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { filterModelsByUserAllowedModels } from "@/app/v1/_lib/models/available-models";
import { providerSupportsModel } from "@/app/v1/_lib/proxy/provider-selector";
import { computeCodexCatalog } from "@/lib/codex-catalog";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

function codexProvider(overrides: Partial<Provider>): Provider {
  return {
    id: 1,
    name: "codex",
    providerType: "codex",
    url: "https://upstream.example.com",
    key: "k",
    allowedModels: null,
    providerPrefix: null,
    isEnabled: true,
    activeTimeStart: null,
    activeTimeEnd: null,
    groupTag: null,
    ...overrides,
  } as unknown as Provider;
}

describe("Codex catalog slugs are accepted by /v1/responses routing", () => {
  it("every slug matches a provider and the user allowedModels", async () => {
    const providers = [
      codexProvider({ id: 1, providerPrefix: "openai/", allowedModels: ["gpt-6.1-sol"] }),
      codexProvider({
        id: 2,
        allowedModels: [
          "gpt-5.5",
          { matchType: "exact", pattern: "GPT-6-Luna" },
          { matchType: "prefix", pattern: "gpt-6-" },
        ],
      }),
      codexProvider({ id: 3, providerPrefix: "openai/test/", allowedModels: ["gpt-6-astra"] }),
    ];
    vi.mocked(findAllProviders).mockResolvedValue(providers);
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");

    const auth = {
      user: {
        id: 1,
        providerGroup: null,
        allowedModels: ["openai/gpt-6.1-sol", "gpt-5.5", "gpt-6-luna", "openai/test/gpt-6-astra"],
      },
      key: { providerGroup: null },
    };
    const { body } = await computeCodexCatalog(auth);
    const slugs = (JSON.parse(body) as { models: { slug: string }[] }).models.map((m) => m.slug);

    expect(slugs.sort()).toEqual(
      ["GPT-6-Luna", "gpt-5.5", "openai/gpt-6.1-sol", "openai/test/gpt-6-astra"].sort()
    );
    for (const slug of slugs) {
      expect(providers.some((p) => providerSupportsModel(p, slug))).toBe(true);
      expect(filterModelsByUserAllowedModels([{ id: slug }], auth.user.allowedModels)).toHaveLength(
        1
      );
    }
  });
});
