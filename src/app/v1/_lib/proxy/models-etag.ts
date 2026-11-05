import { buildCodexCatalogCacheKey, peekCodexCatalog } from "@/lib/codex-catalog/cache";
import type { ProxySession } from "./session";

export const MODELS_ETAG_HEADER = "X-Models-Etag";

/**
 * Attach `X-Models-Etag` to /v1/responses responses.
 *
 * Codex compares this value byte for byte with the `ETag` of the catalog it fetched from
 * `model_catalog_url` and refetches the catalog when they differ. The value is therefore only
 * taken from a catalog already cached in-process for this caller's scope (never built on the
 * request path). Any upstream `X-Models-Etag` is removed: it describes the upstream's own catalog
 * and would make Codex refetch ours on every turn.
 *
 * Only headers change; the body (including SSE streams) is passed through untouched.
 */
export function attachModelsEtag(session: ProxySession, response: Response): Response {
  if (session.originalFormat !== "response") return response;

  const user = session.authState?.user;
  const key = session.authState?.key;
  const etag =
    user && key
      ? peekCodexCatalog(
          buildCodexCatalogCacheKey({
            user: {
              id: user.id,
              providerGroup: user.providerGroup ?? null,
              allowedModels: user.allowedModels ?? null,
            },
            key: { providerGroup: key.providerGroup ?? null },
          })
        )?.etag
      : undefined;

  const upstreamEtag = response.headers.get(MODELS_ETAG_HEADER);
  if (!etag && upstreamEtag === null) return response;
  if (etag && upstreamEtag === etag) return response;

  const headers = new Headers(response.headers);
  if (etag) {
    headers.set(MODELS_ETAG_HEADER, etag);
  } else {
    headers.delete(MODELS_ETAG_HEADER);
  }

  try {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Immutable or already-consumed responses: keep the original rather than failing the request.
    return response;
  }
}
