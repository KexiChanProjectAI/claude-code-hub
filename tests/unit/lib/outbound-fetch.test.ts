import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithDispatcher, getCachedEgressDispatcher, sentinel } = vi.hoisted(() => {
  const sentinel = { kind: "sentinel-dispatcher" };
  return {
    sentinel,
    fetchWithDispatcher: vi.fn(),
    getCachedEgressDispatcher: vi.fn(() => sentinel),
  };
});

vi.mock("@/lib/proxy-agent", () => ({
  fetchWithDispatcher,
  getCachedEgressDispatcher,
  maskProxyUrl: (proxyUrl: string) => proxyUrl,
}));

import { installOutboundProxyFetch } from "@/lib/outbound-fetch";

describe("installOutboundProxyFetch", () => {
  let originalFetch: typeof fetch;
  let captured: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global-proxy:8080");
    fetchWithDispatcher.mockReset();
    fetchWithDispatcher.mockResolvedValue(new Response("proxied"));
    getCachedEgressDispatcher.mockReset();
    getCachedEgressDispatcher.mockReturnValue(sentinel);
    originalFetch = globalThis.fetch;
    captured = vi.fn(async () => new Response("direct"));
    globalThis.fetch = captured as typeof fetch;
    installOutboundProxyFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("sends absolute http(s) requests through the cached dispatcher", async () => {
    await globalThis.fetch("https://example.com/x");

    expect(getCachedEgressDispatcher).toHaveBeenCalledWith("http://global-proxy:8080");
    expect(fetchWithDispatcher).toHaveBeenCalledTimes(1);
    expect(fetchWithDispatcher.mock.calls[0]?.[0]).toBe("https://example.com/x");
    expect(fetchWithDispatcher.mock.calls[0]?.[1]).toMatchObject({ dispatcher: sentinel });
    expect(captured).not.toHaveBeenCalled();
  });

  it("leaves relative fetches on the captured fetch", async () => {
    await globalThis.fetch("/api/health");

    expect(captured).toHaveBeenCalledWith("/api/health", undefined);
    expect(fetchWithDispatcher).not.toHaveBeenCalled();
  });

  it("leaves loopback fetches on the captured fetch", async () => {
    await globalThis.fetch("http://127.0.0.1:9/health");

    expect(captured).toHaveBeenCalledWith("http://127.0.0.1:9/health", undefined);
    expect(fetchWithDispatcher).not.toHaveBeenCalled();
  });

  it("keeps a caller-supplied dispatcher on the captured fetch", async () => {
    const own = { kind: "own-dispatcher" };
    const init = { dispatcher: own } as RequestInit & { dispatcher: unknown };
    await globalThis.fetch("https://example.com/x", init);

    expect(captured).toHaveBeenCalledWith("https://example.com/x", init);
    expect(fetchWithDispatcher).not.toHaveBeenCalled();
  });

  it("unpacks Request objects into url and init for the proxied fetch", async () => {
    await globalThis.fetch(
      new Request("https://example.com/r", {
        method: "POST",
        headers: { "x-test": "1" },
        body: "payload",
      })
    );

    expect(fetchWithDispatcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithDispatcher.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/r");
    expect(init).toMatchObject({ method: "POST", duplex: "half", dispatcher: sentinel });
    expect(new Headers(init.headers).get("x-test")).toBe("1");
    expect(await new Response(init.body).text()).toBe("payload");
  });

  it("does not wrap fetch twice", () => {
    const wrapped = globalThis.fetch;
    installOutboundProxyFetch();
    expect(globalThis.fetch).toBe(wrapped);
  });
});
