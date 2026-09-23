import { afterEach, describe, expect, test, vi } from "vitest";

async function loadEnv() {
  vi.resetModules();
  return import("@/lib/config/env.schema");
}

async function loadListenPrefix() {
  vi.resetModules();
  return import("@/lib/listen-prefix");
}

describe("PROXY_LISTEN_PREFIX env parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to an empty list", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", undefined);
    const { getEnvConfig } = await loadEnv();
    expect(getEnvConfig().PROXY_LISTEN_PREFIX).toEqual([]);
  });

  test("parses and normalizes a comma-separated list", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", " gateway/ , /ai ");
    const { getEnvConfig } = await loadEnv();
    expect(getEnvConfig().PROXY_LISTEN_PREFIX).toEqual(["/gateway", "/ai"]);
  });

  test.each(["/v1", "/", "/gate way", "/api"])("rejects %s at startup", async (raw) => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", raw);
    const { getEnvConfig } = await loadEnv();
    expect(() => getEnvConfig()).toThrow(/PROXY_LISTEN_PREFIX/);
  });
});

describe("getProxyListenPrefixes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns an empty list when unset", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", undefined);
    const { getProxyListenPrefixes } = await loadListenPrefix();
    expect(getProxyListenPrefixes()).toEqual([]);
  });

  test("caches the parsed value and re-parses when the env changes", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gateway");
    const { getProxyListenPrefixes } = await loadListenPrefix();

    const first = getProxyListenPrefixes();
    expect(first).toEqual(["/gateway"]);
    expect(getProxyListenPrefixes()).toBe(first);

    vi.stubEnv("PROXY_LISTEN_PREFIX", "/ai");
    expect(getProxyListenPrefixes()).toEqual(["/ai"]);
  });

  test("throws on an invalid value", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/dashboard");
    const { getProxyListenPrefixes } = await loadListenPrefix();
    expect(() => getProxyListenPrefixes()).toThrow(/PROXY_LISTEN_PREFIX/);
  });

  test("resolveListenPrefixedPath maps prefixed proxy paths only", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gateway");
    const { resolveListenPrefixedPath } = await loadListenPrefix();
    expect(resolveListenPrefixedPath("/gateway/v1/messages")).toBe("/v1/messages");
    expect(resolveListenPrefixedPath("/gateway/dashboard")).toBeNull();
    expect(resolveListenPrefixedPath("/v1/messages")).toBeNull();
  });

  test("resetProxyListenPrefixCacheForTests clears the cache", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gateway");
    const { getProxyListenPrefixes, resetProxyListenPrefixCacheForTests } =
      await loadListenPrefix();
    expect(getProxyListenPrefixes()).toEqual(["/gateway"]);
    resetProxyListenPrefixCacheForTests();
    expect(getProxyListenPrefixes()).toEqual(["/gateway"]);
  });
});
