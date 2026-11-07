import type { ListingClientScope } from "@/app/v1/_lib/models/client-scope";
import { getProviderCacheStats } from "@/lib/cache/provider-cache";
import { TTLMap } from "@/lib/cache/ttl-map";
import { resolveRoutingProviderGroup } from "@/lib/utils/provider-group";

export interface CodexCatalogAuthState {
  user: { id: number; providerGroup: string | null; allowedModels?: string[] | null };
  key: { providerGroup: string | null };
  /** Listing preflight result for the calling client (see client-scope.ts). */
  clientScope?: ListingClientScope;
}

export interface CachedCodexCatalog {
  body: string;
  etag: string;
  modelCount: number;
  builtAt: number;
}

/** After this age an entry is rebuilt on the next request (but kept as a stale fallback). */
export const CODEX_CATALOG_SOFT_TTL_MS = 60_000;
/** Stale entries stay available this long so a slow or failing rebuild can still be answered. */
export const CODEX_CATALOG_STALE_TTL_MS = 10 * 60_000;

const cache = new TTLMap<string, CachedCodexCatalog>({
  ttlMs: CODEX_CATALOG_STALE_TTL_MS,
  maxSize: 500,
});
const inFlight = new Map<string, Promise<CachedCodexCatalog>>();

/**
 * The catalog depends on the codex provider set (versioned by the provider cache), the
 * effective provider group and the user-level allowedModels list. Provider edits bump the
 * provider cache version, so they invalidate catalog entries immediately.
 */
export function buildCodexCatalogCacheKey(auth: CodexCatalogAuthState): string {
  const effectiveGroup = resolveRoutingProviderGroup(auth.key.providerGroup);
  const allowed = [
    ...new Set((auth.user.allowedModels ?? []).map((model) => model.trim().toLowerCase())),
  ]
    .filter(Boolean)
    .sort();
  return `${getProviderCacheStats().version}|${effectiveGroup}|${allowed.join(",")}|${auth.clientScope?.key ?? ""}`;
}

function isFresh(entry: CachedCodexCatalog, now = Date.now()): boolean {
  return now - entry.builtAt < CODEX_CATALOG_SOFT_TTL_MS;
}

/** Read an entry without building it (stale entries included). Never touches upstreams. */
export function peekCodexCatalog(key: string): CachedCodexCatalog | undefined {
  return cache.get(key);
}

/**
 * Read-through with single-flight. Fresh entries are returned directly; otherwise one build
 * runs per key and concurrent callers share it.
 */
export function getOrBuildCodexCatalog(
  key: string,
  build: () => Promise<Omit<CachedCodexCatalog, "builtAt">>
): Promise<CachedCodexCatalog> {
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = build()
    .then((value) => {
      const entry: CachedCodexCatalog = { ...value, builtAt: Date.now() };
      cache.set(key, entry);
      return entry;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function resetCodexCatalogCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
