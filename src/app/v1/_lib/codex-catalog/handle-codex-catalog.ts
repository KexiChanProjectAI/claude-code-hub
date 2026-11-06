import type { Context } from "hono";
import { authenticateApiKeyRequest } from "@/app/v1/_lib/models/authenticate-request";
import { clientScopeForRequest } from "@/app/v1/_lib/models/client-scope";
import {
  buildCodexCatalogCacheKey,
  type CachedCodexCatalog,
  type CodexCatalogAuthState,
  getCodexCatalog,
  peekCodexCatalog,
} from "@/lib/codex-catalog";
import { logger } from "@/lib/logger";

/**
 * Codex CLI model catalog (`model_catalog_url`), served at /v1/codex/models and /codex/models.
 *
 * Contract notes (openai/codex models-manager):
 * - 401/403 make Codex wipe its cached catalog, so they are only returned for genuine
 *   credential failures (handled by authenticateApiKeyRequest). Anything transient is 503.
 * - The whole fetch has a 5 s budget including retries, so builds are capped below that and a
 *   stale catalog is preferred over an error.
 * - Codex never sends If-None-Match; it compares the stored ETag with X-Models-Etag returned by
 *   /v1/responses. 304 is still honored for other clients.
 */

/** Build deadline; Codex aborts the whole catalog refresh after 5 s. */
export const CODEX_CATALOG_BUILD_DEADLINE_MS = 4_000;

class CatalogDeadlineError extends Error {
  constructor() {
    super("codex catalog build deadline exceeded");
  }
}

export function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (!value) return false;

  const opaqueTag = etag.replace(/^W\//, "");
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//, "") === opaqueTag;
  });
}

async function resolveCatalogWithDeadline(
  auth: CodexCatalogAuthState,
  deadlineMs: number
): Promise<CachedCodexCatalog> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CatalogDeadlineError()), deadlineMs);
  });
  try {
    return await Promise.race([getCodexCatalog(auth), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render the catalog for an already-authenticated caller. Shared by the dedicated route and
 * the legacy `/v1/models?client_version=` probe.
 */
export async function renderCodexCatalog(
  c: Context,
  auth: CodexCatalogAuthState,
  options: { deadlineMs?: number } = {}
): Promise<Response> {
  let catalog: CachedCodexCatalog;
  try {
    catalog = await resolveCatalogWithDeadline(
      auth,
      options.deadlineMs ?? CODEX_CATALOG_BUILD_DEADLINE_MS
    );
  } catch (error) {
    const stale = peekCodexCatalog(buildCodexCatalogCacheKey(auth));
    logger.warn("[CodexCatalog] Catalog build failed", {
      userId: auth.user.id,
      timedOut: error instanceof CatalogDeadlineError,
      servedStale: Boolean(stale),
      error: error instanceof Error ? error.message : String(error),
    });
    if (!stale) return serviceUnavailable(c);
    catalog = stale;
  }

  logger.debug("[CodexCatalog] Serving catalog", {
    userId: auth.user.id,
    modelCount: catalog.modelCount,
    originator: c.req.header("originator"),
    clientVersion: c.req.query("client_version"),
  });

  const headers = {
    ETag: catalog.etag,
    "Cache-Control": "no-cache",
  };
  if (matchesIfNoneMatch(c.req.header("if-none-match"), catalog.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(catalog.body, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** GET /v1/codex/models (also /codex/models). */
export async function handleCodexModelCatalog(c: Context): Promise<Response> {
  try {
    const { user, key } = await authenticateApiKeyRequest(c);
    const clientScope = await clientScopeForRequest(c);
    return await renderCodexCatalog(c, { user, key, clientScope });
  } catch (e) {
    if (e instanceof Response) return e;
    // Credential lookup failed for an infrastructure reason (DB/Redis). Never answer 401/403
    // here: Codex would wipe the user's catalog. 503 keeps the last good catalog.
    logger.error("[CodexCatalog] Catalog request failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return serviceUnavailable(c);
  }
}

function serviceUnavailable(c: Context): Response {
  return c.json(
    {
      error: {
        message: "Model catalog is temporarily unavailable, retry later",
        type: "catalog_unavailable",
      },
    },
    503,
    { "Retry-After": "5", "Cache-Control": "no-store" }
  );
}

/** Any other /v1/codex/* path: explicit 404 so it never falls through to the proxy. */
export function handleCodexNotFound(c: Context): Response {
  return c.json(
    { error: { message: `Unknown endpoint: ${c.req.path}`, type: "not_found_error" } },
    404
  );
}
