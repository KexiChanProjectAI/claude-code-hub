/**
 * Clients that set base_url without `/v1` call `/chat/completions`, `/responses`,
 * `/models`, and `/messages` instead of the canonical `/v1/...` endpoints. `/codex` serves the
 * Codex CLI model catalog (`model_catalog_url = "https://host/codex/models"`).
 *
 * Next.js serves those paths via sibling App Router route files; this helper
 * rewrites the Request URL so the Hono app (basePath `/v1`) and the rest of
 * the proxy pipeline see the canonical path.
 */
export const UNPREFIXED_V1_ALIASES = [
  "/chat/completions",
  "/responses",
  "/models",
  "/messages",
  "/codex",
] as const;

/**
 * Protocol-hinted roots: `/<hint>/v1/...` serves the canonical `/v1/...` endpoint, and the
 * hint selects which protocol's models `/v1/models` lists. Clients that configure one base URL
 * per protocol (omp `models.yml`: `.../anthropic/v1`, `.../chat/v1`, `.../responses/v1`) use
 * these. Matched before the plain aliases, so `/responses/v1/...` is not `/v1/responses/v1/...`.
 */
export const PROTOCOL_HINT_ROOTS = [
  { root: "/anthropic", hint: "claude" },
  { root: "/chat", hint: "openai" },
  { root: "/responses", hint: "response" },
] as const;

export type ProtocolHint = (typeof PROTOCOL_HINT_ROOTS)[number]["hint"];

/** Internal header carrying the protocol hint from the rewrite to the handlers. */
export const PROTOCOL_HINT_HEADER = "x-cch-protocol-hint";

const PROTOCOL_HINTS = new Set<string>(PROTOCOL_HINT_ROOTS.map((entry) => entry.hint));

export function isProtocolHint(value: string | null | undefined): value is ProtocolHint {
  return typeof value === "string" && PROTOCOL_HINTS.has(value);
}

/** `/anthropic/v1/messages` -> `{ path: "/v1/messages", hint: "claude" }`; null if not hinted. */
export function resolveProtocolHintPath(
  pathname: string
): { path: string; hint: ProtocolHint } | null {
  const path = trimTrailingSlash(pathname.split("?")[0] || "/");
  for (const { root, hint } of PROTOCOL_HINT_ROOTS) {
    const versioned = `${root}/v1`;
    if (path === versioned || path.startsWith(`${versioned}/`)) {
      return { path: path.slice(root.length), hint };
    }
  }
  return null;
}

type RequestDuplexInit = RequestInit & { duplex?: "half" };

function trimTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function mapUnprefixedV1Path(pathname: string): string {
  const hinted = resolveProtocolHintPath(pathname);
  if (hinted) return hinted.path;
  const path = trimTrailingSlash(pathname.split("?")[0] || "/");
  for (const alias of UNPREFIXED_V1_ALIASES) {
    if (path === alias || path.startsWith(`${alias}/`)) {
      return `/v1${path}`;
    }
  }
  return path;
}

export function rewriteUnprefixedV1Request(request: Request): Request {
  const url = new URL(request.url);
  const hinted = resolveProtocolHintPath(url.pathname);
  const mapped = hinted ? hinted.path : mapUnprefixedV1Path(url.pathname);
  const spoofedHint = !hinted && request.headers.has(PROTOCOL_HINT_HEADER);
  if (mapped === url.pathname && !spoofedHint) {
    return request;
  }

  url.pathname = mapped;
  // The hint header is only ever set here; a client-sent copy is dropped.
  const headers = new Headers(request.headers);
  headers.delete(PROTOCOL_HINT_HEADER);
  if (hinted) headers.set(PROTOCOL_HINT_HEADER, hinted.hint);
  const init: RequestDuplexInit = {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
  };
  if (request.body != null) {
    init.duplex = "half";
  }
  return new Request(url, init as RequestInit);
}
