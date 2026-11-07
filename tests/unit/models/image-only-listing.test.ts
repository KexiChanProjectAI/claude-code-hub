import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn() }));
vi.mock("@/repository/key", () => ({ resolveApiKeyAuthOutcome: vi.fn() }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn() }));
vi.mock("@/lib/utils/provider-schedule", () => ({ isProviderActiveNow: vi.fn() }));
vi.mock("@/lib/cache/provider-cache", () => ({ getProviderCacheStats: () => ({ version: 0 }) }));
vi.mock("@/app/v1/_lib/models/listing-preflight", () => ({
  isListingClientRejected: async () => false,
  findUnhealthyProviderIds: async () => new Set<number>(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { handleCodexModels } from "@/app/v1/_lib/models/available-models";
import { computeCodexCatalog } from "@/lib/codex-catalog";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

const codexProvider = {
  id: 20,
  name: "p",
  providerType: "codex",
  url: "https://upstream.example.com",
  key: "k",
  allowedModels: ["gpt-6-sol", "gpt-image-2", "gpt-image-1.5"],
  providerPrefix: "daily/",
  displayNameSuffix: null,
  isEnabled: true,
  activeTimeStart: null,
  activeTimeEnd: null,
  groupTag: null,
  allowedClients: [],
  blockedClients: [],
} as unknown as Provider;

const auth = { user: { id: 1, providerGroup: null }, key: { providerGroup: null } };

describe("image-only models in chat listings", () => {
  beforeEach(() => {
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
    vi.mocked(findAllProviders).mockResolvedValue([codexProvider]);
    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValue({
      ok: true,
      user: { id: 1, providerGroup: null, isEnabled: true, expiresAt: null },
      key: { providerGroup: null, name: "k" },
    } as never);
  });

  it("are left out of the Codex catalog", async () => {
    const { body } = await computeCodexCatalog(auth);
    const slugs = (JSON.parse(body) as { models: { slug: string }[] }).models.map((m) => m.slug);
    expect(slugs).toEqual(["daily/gpt-6-sol"]);
  });

  it("are left out of /v1/responses/models", async () => {
    const app = new Hono().basePath("/v1");
    app.get("/responses/models", handleCodexModels);
    const response = await app.request("http://localhost/v1/responses/models", {
      headers: { authorization: "Bearer sk" },
    });
    const ids = ((await response.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toEqual(["daily/gpt-6-sol"]);
  });
});
