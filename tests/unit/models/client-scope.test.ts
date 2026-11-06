import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn() }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn() }));
vi.mock("@/lib/utils/provider-schedule", () => ({ isProviderActiveNow: vi.fn() }));
vi.mock("@/lib/cache/provider-cache", () => ({ getProviderCacheStats: () => ({ version: 0 }) }));
vi.mock("@/repository/key", () => ({ resolveApiKeyAuthOutcome: vi.fn() }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn().mockResolvedValue("en") }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { handleCodexModelCatalog } from "@/app/v1/_lib/codex-catalog/handle-codex-catalog";
import {
  clientScopeForRequest,
  clientScopeForSession,
  listingClientSubject,
  resetClientScopeForTests,
  resolveClientScope,
} from "@/app/v1/_lib/models/client-scope";
import { resetCodexCatalogCacheForTests } from "@/lib/codex-catalog/cache";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: 1,
    name: "p",
    providerType: "codex",
    url: "https://upstream.example.com",
    key: "k",
    allowedModels: ["gpt-6.1-sol"],
    providerPrefix: null,
    isEnabled: true,
    activeTimeStart: null,
    activeTimeEnd: null,
    groupTag: null,
    allowedClients: [],
    blockedClients: [],
    ...overrides,
  } as unknown as Provider;
}

const CODEX_UA = "codex_cli_rs/0.166.0 (openEuler 26.09; aarch64) xterm";
const providers = [
  provider({ id: 1 }),
  provider({
    id: 20,
    providerPrefix: "daily/",
    allowedModels: ["gpt-6-sol"],
    allowedClients: ["gemini-cli", "*copilot*"],
  }),
  provider({ id: 30, allowedModels: ["gpt-5.5"], blockedClients: ["codex-cli"] }),
];

describe("resolveClientScope", () => {
  it("blocks providers whose client rules reject the client, as the router does", () => {
    const scope = resolveClientScope(
      listingClientSubject(new Headers({ "user-agent": CODEX_UA }), "/v1/codex/models"),
      providers
    );
    expect([...scope.blockedProviderIds].sort()).toEqual([20, 30]);
    expect(scope.key).toBe("ab20.30");
  });

  it("allows matching clients and keys the outcome", () => {
    const scope = resolveClientScope(
      listingClientSubject(new Headers({ "user-agent": "GitHubCopilot/1.0" }), "/v1/models"),
      providers
    );
    expect([...scope.blockedProviderIds]).toEqual([]);
    expect(scope.key).toBe("a20.30b");
  });

  it("treats a missing user agent as matching no allowlist", () => {
    const scope = resolveClientScope(listingClientSubject(new Headers(), "/v1/models"), providers);
    expect([...scope.blockedProviderIds]).toEqual([20]);
  });
});

describe("clientScopeForSession", () => {
  beforeEach(() => resetClientScopeForTests());

  it("falls back to the last good provider list when the read fails", async () => {
    const subject = listingClientSubject(new Headers({ "user-agent": CODEX_UA }), "/v1/models");
    vi.mocked(findAllProviders).mockResolvedValueOnce(providers);
    const first = await clientScopeForSession(subject);
    vi.mocked(findAllProviders).mockRejectedValueOnce(new Error("db down"));
    expect(await clientScopeForSession(subject)).toEqual(first);
  });

  it("rethrows when there is no previous list", async () => {
    vi.mocked(findAllProviders).mockRejectedValueOnce(new Error("db down"));
    await expect(
      clientScopeForSession(listingClientSubject(new Headers(), "/v1/models"))
    ).rejects.toThrow("db down");
  });

  it("reads headers from a stub context without a raw request", async () => {
    vi.mocked(findAllProviders).mockResolvedValueOnce(providers);
    const stub = {
      req: {
        path: "/v1/models",
        header: (name?: string) => (name === undefined ? { "user-agent": CODEX_UA } : undefined),
      },
    };
    const scope = await clientScopeForRequest(stub as never);
    expect([...scope.blockedProviderIds].sort()).toEqual([20, 30]);

    vi.mocked(findAllProviders).mockResolvedValueOnce(providers);
    const throwing = {
      req: {
        path: "/v1/models",
        header: () => {
          throw new Error("no headers");
        },
      },
    };
    expect([...(await clientScopeForRequest(throwing as never)).blockedProviderIds]).toEqual([20]);
  });
});

describe("Codex catalog honors provider client restrictions", () => {
  beforeEach(() => {
    resetClientScopeForTests();
    resetCodexCatalogCacheForTests();
    vi.mocked(findAllProviders).mockResolvedValue(providers);
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValue({
      ok: true,
      user: { id: 1, providerGroup: null, isEnabled: true, expiresAt: null },
      key: { providerGroup: null, name: "k" },
    } as never);
  });

  async function slugsFor(userAgent: string) {
    const app = new Hono().basePath("/v1");
    app.get("/codex/models", handleCodexModelCatalog);
    const response = await app.request("http://localhost/v1/codex/models", {
      headers: { authorization: "Bearer sk", "user-agent": userAgent },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { models: { slug: string }[] }).models.map((m) => m.slug);
  }

  it("hides models only a client-restricted provider serves", async () => {
    expect(await slugsFor(CODEX_UA)).toEqual(["gpt-6.1-sol"]);
  });

  it("lists them for a client the provider allows", async () => {
    expect((await slugsFor("GitHubCopilot/1.0")).sort()).toEqual(
      ["daily/gpt-6-sol", "gpt-5.5", "gpt-6.1-sol"].sort()
    );
  });
});
