// Shared helper for the optional extra listen prefix (PROXY_LISTEN_PREFIX).
//
// Purpose: let deployments mount the proxy API under one or more additional
// path prefixes (e.g. `/gateway/v1/messages` alongside `/v1/messages`) when a
// shared domain routes by path. The prefix is stripped at the entry layer so
// every downstream component (Hono apps, guards, converters, session, billing)
// keeps seeing the canonical path.
//
// Two entry layers use this module:
// - server.js (prod via cluster.js, and `bun run dev:server`): rewrites
//   `req.url` before handing to Next, and accepts prefixed WebSocket upgrades.
// - src/proxy.ts (Next middleware; the only layer under plain `next dev`):
//   NextResponse.rewrite() to the stripped path.
//
// Kept dependency-free CJS so server.js can require it directly while the
// TypeScript side imports it through src/lib/listen-prefix.ts (same pattern as
// server-lib/spool-directory.js and server-lib/memory-governor.js).

"use strict";

// Canonical proxy path roots. A prefixed path only gets rewritten when the
// remainder after the prefix is one of these (exact, or followed by `/`).
// KEEP IN SYNC with UNPREFIXED_V1_ALIASES in src/app/v1/_lib/unprefixed-v1-alias.ts
// (plus the two versioned Hono basePaths); the unit test asserts no drift.
const PROXY_PATH_ROOTS = [
  "/v1",
  "/v1beta",
  "/chat/completions",
  "/responses",
  "/models",
  "/messages",
];

// A prefix whose first segment is one of these would shadow an existing route:
// management API, proxy roots, Next internals, app pages, or an i18n locale.
// KEEP IN SYNC with routing.locales (src/i18n/config.ts) and the alias list
// above; the unit test cross-checks both.
const RESERVED_FIRST_SEGMENTS = new Set([
  "api",
  "v1",
  "v1beta",
  "_next",
  "favicon.ico",
  "login",
  "status",
  "usage-doc",
  "dashboard",
  "chat",
  "responses",
  "models",
  "messages",
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ru",
]);

const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MAX_PREFIX_LENGTH = 128;

/**
 * Parse the raw PROXY_LISTEN_PREFIX value into normalized prefixes.
 *
 * Accepts a comma-separated list. Each entry gets a leading slash if missing
 * and has trailing slashes stripped. Matching is case-sensitive and operates
 * on raw (undecoded) pathnames, so percent-encoded prefixes are rejected.
 *
 * Never throws: callers decide how to surface `error`.
 *
 * @param {unknown} raw
 * @returns {{ prefixes: string[], error: string | null }}
 */
function parseListenPrefixes(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { prefixes: [], error: null };
  }

  const prefixes = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    let normalized = withSlash;
    while (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    if (normalized === "" || normalized === "/") {
      return { prefixes: [], error: `"${trimmed}" must contain at least one path segment` };
    }
    if (normalized.length > MAX_PREFIX_LENGTH) {
      return { prefixes: [], error: `"${trimmed}" exceeds ${MAX_PREFIX_LENGTH} characters` };
    }

    const segments = normalized.slice(1).split("/");
    for (const segment of segments) {
      if (segment === "") {
        return { prefixes: [], error: `"${trimmed}" contains an empty path segment` };
      }
      if (segment === "." || segment === "..") {
        return { prefixes: [], error: `"${trimmed}" contains a relative path segment` };
      }
      if (!SEGMENT_PATTERN.test(segment)) {
        return {
          prefixes: [],
          error: `"${trimmed}" contains an invalid character in segment "${segment}" (allowed: A-Z a-z 0-9 . _ ~ -)`,
        };
      }
    }

    const firstSegment = segments[0];
    if (RESERVED_FIRST_SEGMENTS.has(firstSegment)) {
      return {
        prefixes: [],
        error: `"${trimmed}" starts with the reserved segment "${firstSegment}"`,
      };
    }

    for (const existing of prefixes) {
      if (existing === normalized) {
        return { prefixes: [], error: `"${trimmed}" is listed more than once` };
      }
      if (existing.startsWith(`${normalized}/`) || normalized.startsWith(`${existing}/`)) {
        return {
          prefixes: [],
          error: `"${trimmed}" overlaps with "${existing}"; prefixes must not nest`,
        };
      }
    }

    prefixes.push(normalized);
  }

  return { prefixes, error: null };
}

/**
 * Strip a configured listen prefix from a pathname.
 *
 * Returns the canonical remainder (e.g. "/v1/messages", "/responses") when the
 * pathname sits under a prefix AND the remainder is a proxy path; otherwise
 * null, so the caller leaves the request untouched.
 *
 * @param {string} pathname raw pathname, no query string
 * @param {readonly string[]} prefixes normalized prefixes
 * @returns {string | null}
 */
function stripListenPrefix(pathname, prefixes) {
  if (typeof pathname !== "string" || !Array.isArray(prefixes) || prefixes.length === 0) {
    return null;
  }

  for (const prefix of prefixes) {
    // Require a segment boundary so `/gatewayx/v1/...` does not match `/gateway`,
    // and `pathname === prefix` (nothing underneath) falls through.
    if (!pathname.startsWith(`${prefix}/`)) continue;

    const rest = pathname.slice(prefix.length);
    for (const root of PROXY_PATH_ROOTS) {
      if (rest === root || rest.startsWith(`${root}/`)) {
        return rest;
      }
    }
  }

  return null;
}

/**
 * Strip a listen prefix from a raw request URL, preserving the query string
 * verbatim (no decoding, so `parse(req.url, true)` keeps its semantics).
 *
 * @param {unknown} rawUrl
 * @param {readonly string[]} prefixes
 * @returns {string | null} rewritten "path?query", or null when untouched
 */
function rewriteListenPrefixedUrl(rawUrl, prefixes) {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;

  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const suffix = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);

  const stripped = stripListenPrefix(pathname, prefixes);
  if (stripped === null) return null;

  return `${stripped}${suffix}`;
}

module.exports = {
  parseListenPrefixes,
  stripListenPrefix,
  rewriteListenPrefixedUrl,
  PROXY_PATH_ROOTS,
  RESERVED_FIRST_SEGMENTS,
};
