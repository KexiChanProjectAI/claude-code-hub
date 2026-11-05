import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repository/key", () => ({ resolveApiKeyAuthOutcome: vi.fn() }));
vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));
vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn().mockResolvedValue("UTC"),
}));
vi.mock("@/lib/utils/provider-schedule", () => ({
  isProviderActiveNow: vi.fn().mockReturnValue(true),
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  checkProviderGroupMatch: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/cache/provider-cache", () => ({
  getProviderCacheStats: () => ({ version: 0 }),
}));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn().mockResolvedValue("en") }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/utils/error-messages", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils/error-messages")>(
    "@/lib/utils/error-messages"
  );
  return {
    ...actual,
    getErrorMessageServer: vi.fn(async (_locale: string, code: string) => code),
  };
});

import {
  CODEX_CATALOG_BUILD_DEADLINE_MS,
  handleCodexModelCatalog,
  handleCodexNotFound,
  matchesIfNoneMatch,
  renderCodexCatalog,
} from "@/app/v1/_lib/codex-catalog/handle-codex-catalog";
import { handleAvailableModels } from "@/app/v1/_lib/models/available-models";
import {
  CODEX_CATALOG_SOFT_TTL_MS,
  CodexCatalogResponseSchema,
  resetCodexCatalogCacheForTests,
} from "@/lib/codex-catalog";
import { checkProviderGroupMatch } from "@/app/v1/_lib/proxy/provider-selector";
import { isProviderActiveNow } from "@/lib/utils/provider-schedule";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

function codexProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "codex-upstream",
    providerType: "codex",
    url: "https://upstream.example.com",
    key: "upstream-key",
    allowedModels: ["gpt-6.1-sol", "gpt-5.5"],
    providerPrefix: null,
    isEnabled: true,
    activeTimeStart: null,
    activeTimeEnd: null,
    groupTag: null,
    ...overrides,
  } as unknown as Provider;
}

function createApp() {
  const app = new Hono().basePath("/v1");
  app.get("/models", handleAvailableModels);
  app.get("/codex/models", handleCodexModelCatalog);
  app.all("/codex/*", handleCodexNotFound);
  return app;
}

function get(path: string, headers: Record<string, string> = {}) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: "Bearer sk-test", ...headers },
  });
}

describe("Codex model catalog endpoint", () => {
  beforeEach(() => {
    resetCodexCatalogCacheForTests();
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    vi.mocked(checkProviderGroupMatch).mockReturnValue(true);
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValue({
      ok: true,
      user: { id: 1, providerGroup: null, isEnabled: true, expiresAt: null },
      key: { providerGroup: null, name: "test-key" },
    } as never);
    vi.mocked(findAllProviders).mockResolvedValue([
      codexProvider(),
      codexProvider({
        id: 2,
        providerPrefix: "openai/test/",
        allowedModels: ["gpt-6.1-sol", "deepseek-v4"],
      }),
      codexProvider({ id: 3, providerType: "claude", allowedModels: ["claude-x"] }),
    ]);
  });

  it("returns a Codex-parsable catalog of codex provider models", async () => {
    const response = await get("/v1/codex/models?client_version=0.153.0&extra=1", {
      originator: "codex_cli_rs",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^"cch-codex-[0-9a-f]{32}"$/);

    const body = CodexCatalogResponseSchema.parse(await response.json());
    expect(body.models.map((m) => m.slug)).toEqual([
      "gpt-6.1-sol",
      "openai/test/gpt-6.1-sol",
      "gpt-5.5",
      "openai/test/deepseek-v4",
    ]);
    expect(body.models.every((m) => m.supported_in_api)).toBe(true);
    expect(new Set(body.models.map((m) => m.slug)).size).toBe(body.models.length);
  });

  it("returns an empty but valid catalog when no codex provider is available", async () => {
    vi.mocked(findAllProviders).mockResolvedValue([]);
    const response = await get("/v1/codex/models");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [] });
  });

  it("honors If-None-Match", async () => {
    const etag = (await get("/v1/codex/models")).headers.get("etag")!;
    for (const value of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = await get("/v1/codex/models", { "if-none-match": value });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(await response.text()).toBe("");
    }
    expect((await get("/v1/codex/models", { "if-none-match": '"stale"' })).status).toBe(200);
  });

  it("returns 401 only for credential failures", async () => {
    const missing = await createApp().request("http://localhost/v1/codex/models");
    expect(missing.status).toBe(401);

    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const invalid = await get("/v1/codex/models");
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({
      error: { message: "PROXY_INVALID_API_KEY", type: "invalid_api_key" },
    });
  });

  it("returns 503 (not 401) when the credential lookup itself fails", async () => {
    vi.mocked(resolveApiKeyAuthOutcome).mockRejectedValueOnce(new Error("db down"));
    const response = await get("/v1/codex/models");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect((await response.json()).error.type).toBe("catalog_unavailable");
  });

  it("returns 503 when the build fails without a cached catalog", async () => {
    vi.mocked(findAllProviders).mockRejectedValue(new Error("boom"));
    const response = await get("/v1/codex/models");
    expect(response.status).toBe(503);
  });

  it("serves the stale catalog when a rebuild fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = await get("/v1/codex/models");
      const etag = first.headers.get("etag");

      vi.setSystemTime(Date.now() + CODEX_CATALOG_SOFT_TTL_MS + 1);
      vi.mocked(findAllProviders).mockRejectedValue(new Error("boom"));
      const second = await get("/v1/codex/models");
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).toBe(etag);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 503 when the build exceeds the deadline", async () => {
    vi.mocked(findAllProviders).mockReturnValue(new Promise(() => {}));
    const app = new Hono();
    app.get("/x", (c) =>
      renderCodexCatalog(
        c,
        { user: { id: 1, providerGroup: null }, key: { providerGroup: null } },
        { deadlineMs: 10 }
      )
    );
    const response = await app.request("http://localhost/x");
    expect(response.status).toBe(503);
    expect(CODEX_CATALOG_BUILD_DEADLINE_MS).toBeLessThan(5_000);
  });

  it("returns 404 for unknown /codex paths", async () => {
    const response = await get("/v1/codex/other");
    expect(response.status).toBe(404);
    expect((await response.json()).error.type).toBe("not_found_error");
  });

  it("serves the same catalog on the legacy /v1/models?client_version= probe", async () => {
    const catalog = await get("/v1/codex/models");
    const legacy = await get("/v1/models?client_version=0.144.1");
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("etag")).toBe(catalog.headers.get("etag"));
    expect(await legacy.text()).toBe(await catalog.text());
  });
});

describe("matchesIfNoneMatch", () => {
  it("handles missing and non-matching values", () => {
    expect(matchesIfNoneMatch(undefined, '"a"')).toBe(false);
    expect(matchesIfNoneMatch('"b"', '"a"')).toBe(false);
    expect(matchesIfNoneMatch(' "b" , W/"a"', '"a"')).toBe(true);
  });
});
