import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { UNPREFIXED_V1_ALIASES } from "@/app/v1/_lib/unprefixed-v1-alias";
import { locales } from "@/i18n/config";

const requireFromHere = createRequire(import.meta.url);

type ListenPrefixModule = {
  parseListenPrefixes: (raw: unknown) => { prefixes: string[]; error: string | null };
  stripListenPrefix: (pathname: string, prefixes: readonly string[]) => string | null;
  rewriteListenPrefixedUrl: (rawUrl: unknown, prefixes: readonly string[]) => string | null;
  PROXY_PATH_ROOTS: string[];
  RESERVED_FIRST_SEGMENTS: Set<string>;
};

const {
  parseListenPrefixes,
  stripListenPrefix,
  rewriteListenPrefixedUrl,
  PROXY_PATH_ROOTS,
  RESERVED_FIRST_SEGMENTS,
} = requireFromHere("../../server-lib/listen-prefix.js") as ListenPrefixModule;

describe("parseListenPrefixes", () => {
  it.each([undefined, null, "", "   ", 42, {}])("treats %s as disabled", (raw) => {
    expect(parseListenPrefixes(raw)).toEqual({ prefixes: [], error: null });
  });

  it.each([
    ["/gateway", ["/gateway"]],
    ["gateway", ["/gateway"]],
    ["/gateway/", ["/gateway"]],
    ["/gateway///", ["/gateway"]],
    ["/ai/gateway", ["/ai/gateway"]],
    [" /gateway , /ai/ ", ["/gateway", "/ai"]],
    ["/gateway,,/ai", ["/gateway", "/ai"]],
    ["/Gateway", ["/Gateway"]],
    ["/g-a_t.e~w", ["/g-a_t.e~w"]],
  ])("normalizes %s", (raw, expected) => {
    expect(parseListenPrefixes(raw)).toEqual({ prefixes: expected, error: null });
  });

  it.each([
    "/",
    "//",
    "///",
    "/a//b",
    "/gate way",
    "/gate%20way",
    "/gateway?x",
    "/gateway#x",
    "/.",
    "/..",
    "/网关",
    `/${"x".repeat(200)}`,
  ])("rejects %s", (raw) => {
    const result = parseListenPrefixes(raw);
    expect(result.prefixes).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it.each([...RESERVED_FIRST_SEGMENTS])("rejects reserved first segment %s", (segment) => {
    const result = parseListenPrefixes(`/${segment}/sub`);
    expect(result.error).toContain("reserved segment");
  });

  it("rejects duplicates", () => {
    expect(parseListenPrefixes("/gateway,/gateway/").error).toContain("more than once");
  });

  it.each([
    ["/a,/a/b", "overlaps"],
    ["/a/b,/a", "overlaps"],
  ])("rejects nested prefixes %s", (raw, expected) => {
    expect(parseListenPrefixes(raw).error).toContain(expected);
  });

  it("does not reject sibling prefixes sharing a textual stem", () => {
    expect(parseListenPrefixes("/gw,/gw2")).toEqual({
      prefixes: ["/gw", "/gw2"],
      error: null,
    });
  });
});

describe("stripListenPrefix", () => {
  const prefixes = ["/gw", "/ai/gateway"];

  it.each([
    ["/gw/v1/messages", "/v1/messages"],
    ["/gw/v1", "/v1"],
    ["/gw/v1/messages/count_tokens", "/v1/messages/count_tokens"],
    ["/gw/v1beta/models/gemini-pro:generateContent", "/v1beta/models/gemini-pro:generateContent"],
    ["/gw/v1beta", "/v1beta"],
    ["/gw/responses", "/responses"],
    ["/gw/responses/compact", "/responses/compact"],
    ["/gw/chat/completions", "/chat/completions"],
    ["/gw/chat/completions/models", "/chat/completions/models"],
    ["/gw/models", "/models"],
    ["/gw/messages", "/messages"],
    ["/gw/messages/count_tokens", "/messages/count_tokens"],
    ["/gw/v1/responses/", "/v1/responses/"],
    ["/ai/gateway/v1/messages", "/v1/messages"],
  ])("strips %s", (pathname, expected) => {
    expect(stripListenPrefix(pathname, prefixes)).toBe(expected);
  });

  it.each([
    "/gw",
    "/gw/",
    "/gw/dashboard",
    "/gw/api/v1/keys",
    "/gw/chat",
    "/gw/response",
    "/gw/v10/x",
    "/gw/v1x",
    "/gwx/v1/messages",
    "/Gw/v1/messages",
    "/gw//v1/messages",
    "/v1/messages",
    "/v1/gw/messages",
    "/ai/v1/messages",
  ])("returns null for %s", (pathname) => {
    expect(stripListenPrefix(pathname, prefixes)).toBeNull();
  });

  it("returns null when no prefixes are configured", () => {
    expect(stripListenPrefix("/gw/v1/messages", [])).toBeNull();
  });

  it("matches the second configured prefix", () => {
    expect(stripListenPrefix("/b/v1/models", ["/a", "/b"])).toBe("/v1/models");
  });
});

describe("rewriteListenPrefixedUrl", () => {
  const prefixes = ["/gw"];

  it.each([
    ["/gw/v1/messages", "/v1/messages"],
    ["/gw/v1/messages?beta=1&x=%2F", "/v1/messages?beta=1&x=%2F"],
    ["/gw/responses?", "/responses?"],
  ])("rewrites %s", (rawUrl, expected) => {
    expect(rewriteListenPrefixedUrl(rawUrl, prefixes)).toBe(expected);
  });

  it.each(["/v1/messages?x=1", "/gw/dashboard", "", undefined])("leaves %s untouched", (rawUrl) => {
    expect(rewriteListenPrefixedUrl(rawUrl, prefixes)).toBeNull();
  });
});

describe("drift guards", () => {
  it("covers every unprefixed alias plus both versioned roots", () => {
    expect(new Set(PROXY_PATH_ROOTS)).toEqual(
      new Set(["/v1", "/v1beta", ...UNPREFIXED_V1_ALIASES])
    );
  });

  it("reserves every supported locale", () => {
    for (const locale of locales) {
      expect(RESERVED_FIRST_SEGMENTS.has(locale)).toBe(true);
    }
  });

  it("reserves the first segment of every unprefixed alias", () => {
    for (const alias of UNPREFIXED_V1_ALIASES) {
      expect(RESERVED_FIRST_SEGMENTS.has(alias.split("/")[1] as string)).toBe(true);
    }
  });
});
