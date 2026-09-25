import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOutboundProxyUrl } from "@/lib/outbound-proxy";

const ENV_KEYS = [
  "OUTBOUND_PROXY_URL",
  "PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

describe("resolveOutboundProxyUrl", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps an explicit proxy ahead of global and legacy env", () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global:8080");
    vi.stubEnv("PROXY", "http://legacy:9");

    expect(
      resolveOutboundProxyUrl({
        explicit: "http://provider-proxy:3128",
        targetUrl: "https://api.anthropic.com",
      })
    ).toEqual({ proxyUrl: "http://provider-proxy:3128", source: "explicit" });
  });

  it("uses OUTBOUND_PROXY_URL when no explicit proxy is set", () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global:8080");

    expect(
      resolveOutboundProxyUrl({
        explicit: "",
        targetUrl: "https://api.anthropic.com",
      })
    ).toEqual({ proxyUrl: "http://global:8080", source: "global" });

    expect(
      resolveOutboundProxyUrl({
        explicit: "",
        targetUrl: "https://api.anthropic.com",
        legacyEnv: true,
      })
    ).toEqual({ proxyUrl: "http://global:8080", source: "global" });
  });

  it("uses legacy env only when legacyEnv is true and the global proxy is unset", () => {
    vi.stubEnv("PROXY", "http://legacy:9");

    expect(
      resolveOutboundProxyUrl({
        explicit: "",
        targetUrl: "https://api.anthropic.com",
        legacyEnv: false,
      })
    ).toEqual({ proxyUrl: null, source: "none" });

    expect(
      resolveOutboundProxyUrl({
        explicit: "",
        targetUrl: "https://api.anthropic.com",
        legacyEnv: true,
      })
    ).toEqual({ proxyUrl: "http://legacy:9", source: "legacy-env" });
  });

  it.each([
    "http://127.0.0.1:8123/",
    "https://localhost/v1",
    "http://[::1]:8080/",
    "http://0.0.0.0/",
  ])("bypasses %s even when legacy env is set", (targetUrl) => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global:8080");
    vi.stubEnv("PROXY", "http://legacy:9");

    expect(
      resolveOutboundProxyUrl({
        explicit: "",
        targetUrl,
        legacyEnv: true,
      })
    ).toEqual({ proxyUrl: null, source: "none" });
  });

  it("does not bypass an explicit proxy for loopback targets", () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global:8080");

    expect(
      resolveOutboundProxyUrl({
        explicit: "http://provider-proxy:3128",
        targetUrl: "http://127.0.0.1:9/",
      })
    ).toEqual({ proxyUrl: "http://provider-proxy:3128", source: "explicit" });
  });

  it("honors NO_PROXY host, suffix, and wildcard matches", () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://global:8080");
    vi.stubEnv("NO_PROXY", "clickhouse,example.com");

    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "http://clickhouse:8123/",
      }).proxyUrl
    ).toBeNull();
    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "https://api.example.com/v1",
      }).proxyUrl
    ).toBeNull();
    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "https://api.anthropic.com",
      })
    ).toEqual({ proxyUrl: "http://global:8080", source: "global" });

    vi.stubEnv("NO_PROXY", "*");
    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "https://api.anthropic.com",
      }).proxyUrl
    ).toBeNull();

    vi.stubEnv("NO_PROXY", ".example.com");
    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "https://a.example.com",
      }).proxyUrl
    ).toBeNull();
  });

  it("ignores HTTPS_PROXY unless legacyEnv is enabled", () => {
    vi.stubEnv("HTTPS_PROXY", "http://legacy:9");

    expect(
      resolveOutboundProxyUrl({
        explicit: null,
        targetUrl: "https://api.anthropic.com",
        legacyEnv: false,
      })
    ).toEqual({ proxyUrl: null, source: "none" });
  });
});
