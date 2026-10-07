import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

vi.mock("undici", () => ({ request: vi.fn() }));
vi.mock("@/repository/key", () => ({ resolveApiKeyAuthOutcome: vi.fn() }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn() }));
vi.mock("@/lib/utils/provider-schedule", () => ({ isProviderActiveNow: vi.fn() }));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({ checkProviderGroupMatch: vi.fn() }));
vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn() }));

import { getAvailableModelsGroupedByProviderType } from "@/app/v1/_lib/models/available-models";
import { checkProviderGroupMatch } from "@/app/v1/_lib/proxy/provider-selector";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { findAllProviders } from "@/repository/provider";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: 1,
    name: "p",
    providerType: "claude",
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

const auth = {
  user: { id: 1, providerGroup: null as string | null, allowedModels: [] as string[] },
  key: { providerGroup: null as string | null },
};

beforeEach(() => {
  vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
  vi.mocked(isProviderActiveNow).mockReturnValue(true);
  vi.mocked(checkProviderGroupMatch).mockImplementation(
    (groupTag: string | null, group: string) => groupTag === group
  );
  vi.mocked(findAllProviders).mockResolvedValue([
    provider({ id: 1, providerType: "claude", allowedModels: ["b-model", "a-model"] }),
    provider({ id: 2, providerType: "claude-auth", allowedModels: ["a-model", "c-model"] }),
    provider({ id: 3, providerType: "codex", allowedModels: ["a-model"] }),
    provider({
      id: 4,
      providerType: "openai-compatible",
      allowedModels: ["gpt-5", { matchType: "prefix", pattern: "gpt-" }],
      providerPrefix: "oa/",
    }),
    provider({ id: 5, providerType: "gemini", allowedModels: ["g"], isEnabled: false }),
  ]);
});

describe("getAvailableModelsGroupedByProviderType", () => {
  it("groups by provider type in request order, deduped and sorted", async () => {
    const { groups } = await getAvailableModelsGroupedByProviderType(auth, [
      "codex",
      "claude",
      "claude-auth",
      "openai-compatible",
      "gemini",
    ]);
    expect(groups.map((g) => [g.providerType, g.models.map((m) => m.id)])).toEqual([
      ["codex", ["a-model"]],
      ["claude", ["a-model", "b-model"]],
      ["claude-auth", ["a-model", "c-model"]],
      ["openai-compatible", ["oa/gpt-5"]],
    ]);
  });

  it("applies the user allowedModels filter per group and drops empty groups", async () => {
    const { groups } = await getAvailableModelsGroupedByProviderType(
      { ...auth, user: { ...auth.user, allowedModels: ["C-MODEL"] } },
      ["claude", "claude-auth"]
    );
    expect(groups).toEqual([{ providerType: "claude-auth", models: [{ id: "c-model" }] }]);
  });

  it("returns no groups when no provider matches the effective group", async () => {
    const result = await getAvailableModelsGroupedByProviderType(
      { ...auth, key: { providerGroup: "vip" } },
      ["claude"]
    );
    expect(result).toEqual({ groups: [] });
  });
});
