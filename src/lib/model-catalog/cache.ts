import { TTLMap } from "@/lib/cache/ttl-map";
import type { CatalogAuthState, ModelCatalog } from "./types";

export type CachedCatalog = Omit<ModelCatalog, "notes">;

/**
 * The enumerated catalog depends only on the effective provider group and the user-level
 * allowedModels list (plus global provider/price state), so keys sharing those values share an
 * entry. Provider, price and allowedModels edits converge within the TTL.
 */
export const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

const cache = new TTLMap<string, CachedCatalog>({
  ttlMs: MODEL_CATALOG_CACHE_TTL_MS,
  maxSize: 500,
});
const inFlight = new Map<string, Promise<CachedCatalog>>();

export function buildCatalogCacheKey(auth: CatalogAuthState): string {
  const effectiveGroup = auth.key.providerGroup || auth.user.providerGroup || "";
  const allowed = [
    ...new Set((auth.user.allowedModels ?? []).map((model) => model.trim().toLowerCase())),
  ]
    .filter(Boolean)
    .sort();
  return `${effectiveGroup}|${allowed.join(",")}`;
}

/** Read-through with single-flight so concurrent misses for one key build once. */
export async function getOrBuildCatalog(
  key: string,
  build: () => Promise<CachedCatalog>
): Promise<CachedCatalog> {
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = build()
    .then((value) => {
      cache.set(key, value);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function resetModelCatalogCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
