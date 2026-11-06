import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerCache = vi.hoisted(() => ({ version: 7 }));
vi.mock("@/lib/cache/provider-cache", () => ({
  getProviderCacheStats: () => ({ version: providerCache.version }),
}));

import {
  buildCodexCatalogCacheKey,
  CODEX_CATALOG_SOFT_TTL_MS,
  CODEX_CATALOG_STALE_TTL_MS,
  getOrBuildCodexCatalog,
  peekCodexCatalog,
  resetCodexCatalogCacheForTests,
} from "@/lib/codex-catalog/cache";

const value = (etag: string) => ({ body: "{}", etag, modelCount: 0 });

describe("buildCodexCatalogCacheKey", () => {
  it("includes provider cache version, effective group and normalized allowedModels", () => {
    const key = buildCodexCatalogCacheKey({
      user: { id: 1, providerGroup: "user-group", allowedModels: [" B ", "a", "b"] },
      key: { providerGroup: "key-group" },
    });
    expect(key).toBe("7|key-group|a,b|");

    providerCache.version = 8;
    expect(
      buildCodexCatalogCacheKey({
        user: { id: 2, providerGroup: "user-group" },
        key: { providerGroup: null },
      })
    ).toBe("8|user-group||");
  });
});

describe("getOrBuildCodexCatalog", () => {
  beforeEach(() => {
    resetCodexCatalogCacheForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("builds once for concurrent callers", async () => {
    const build = vi.fn(async () => value("a"));
    const [x, y] = await Promise.all([
      getOrBuildCodexCatalog("k", build),
      getOrBuildCodexCatalog("k", build),
    ]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
    expect(x.builtAt).toBe(Date.now());
  });

  it("serves fresh entries and rebuilds after the soft TTL", async () => {
    const build = vi.fn().mockResolvedValueOnce(value("a")).mockResolvedValueOnce(value("b"));
    await getOrBuildCodexCatalog("k", build);
    expect((await getOrBuildCodexCatalog("k", build)).etag).toBe("a");

    vi.advanceTimersByTime(CODEX_CATALOG_SOFT_TTL_MS);
    expect((await getOrBuildCodexCatalog("k", build)).etag).toBe("b");
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("keeps a stale entry readable after a failed rebuild", async () => {
    await getOrBuildCodexCatalog("k", async () => value("a"));
    vi.advanceTimersByTime(CODEX_CATALOG_SOFT_TTL_MS + 1);
    await expect(
      getOrBuildCodexCatalog("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(peekCodexCatalog("k")?.etag).toBe("a");

    vi.advanceTimersByTime(CODEX_CATALOG_STALE_TTL_MS);
    expect(peekCodexCatalog("k")).toBeUndefined();
  });

  it("peek never builds", () => {
    expect(peekCodexCatalog("missing")).toBeUndefined();
  });
});
