import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before imports -- mirror proxy-auth-cookie-passthrough.test.ts so
// next-intl does not pull in next/navigation (not resolvable in vitest).
const mockIntlMiddleware = vi.hoisted(() => vi.fn());
vi.mock("next-intl/middleware", () => ({
  default: () => mockIntlMiddleware,
}));

vi.mock("@/i18n/routing", () => ({
  routing: {
    locales: ["zh-CN", "en"],
    defaultLocale: "zh-CN",
  },
}));

vi.mock("@/lib/config/env.schema", () => ({
  isDevelopment: () => false,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRequest(pathname: string, search = "", method = "POST") {
  const url = new URL(`http://localhost:13500${pathname}${search}`);
  return {
    method,
    nextUrl: { pathname, clone: () => new URL(url) },
    cookies: {
      get: () => undefined,
    },
    headers: new Headers(),
  } as unknown as import("next/server").NextRequest;
}

async function loadProxy() {
  vi.resetModules();
  return import("@/proxy");
}

describe("listen prefix rewrite in the Next proxy handler", () => {
  beforeEach(() => {
    mockIntlMiddleware.mockReturnValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    ["/gw/v1/messages", "/v1/messages"],
    ["/gw/v1/responses", "/v1/responses"],
    ["/gw/v1/chat/completions", "/v1/chat/completions"],
    ["/gw/v1beta/models", "/v1beta/models"],
    ["/gw/responses", "/responses"],
    ["/gw/chat/completions", "/chat/completions"],
    ["/gw/models", "/models"],
    ["/gw/messages/count_tokens", "/messages/count_tokens"],
  ])("rewrites %s to %s", async (pathname, expected) => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gw");
    const { default: proxyHandler } = await loadProxy();

    const response = await proxyHandler(makeRequest(pathname));
    const rewrite = response.headers.get("x-middleware-rewrite");

    expect(rewrite).toBeTruthy();
    expect(new URL(rewrite as string).pathname).toBe(expected);
    expect(response.headers.get("location")).toBeNull();
    expect(mockIntlMiddleware).not.toHaveBeenCalled();
  });

  it("preserves the query string", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gw");
    const { default: proxyHandler } = await loadProxy();

    const response = await proxyHandler(makeRequest("/gw/v1/messages", "?beta=true&x=1"));
    const rewrite = new URL(response.headers.get("x-middleware-rewrite") as string);

    expect(rewrite.pathname).toBe("/v1/messages");
    expect(rewrite.search).toBe("?beta=true&x=1");
  });

  it("supports several configured prefixes", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gw,/ai");
    const { default: proxyHandler } = await loadProxy();

    for (const prefix of ["/gw", "/ai"]) {
      const response = await proxyHandler(makeRequest(`${prefix}/v1/models`, "", "GET"));
      const rewrite = new URL(response.headers.get("x-middleware-rewrite") as string);
      expect(rewrite.pathname).toBe("/v1/models");
    }
  });

  it.each(["/gw", "/gw/dashboard", "/gw/api/v1/keys", "/gwx/v1/messages"])(
    "does not rewrite %s",
    async (pathname) => {
      vi.stubEnv("PROXY_LISTEN_PREFIX", "/gw");
      const { default: proxyHandler } = await loadProxy();

      const response = await proxyHandler(makeRequest(pathname, "", "GET"));
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    }
  );

  it("falls through when no prefix is configured", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", undefined);
    const { default: proxyHandler } = await loadProxy();

    const response = await proxyHandler(makeRequest("/gw/v1/messages", "", "GET"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves canonical proxy paths untouched", async () => {
    vi.stubEnv("PROXY_LISTEN_PREFIX", "/gw");
    const { default: proxyHandler } = await loadProxy();

    const response = await proxyHandler(makeRequest("/v1/messages"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(mockIntlMiddleware).not.toHaveBeenCalled();
  });
});
