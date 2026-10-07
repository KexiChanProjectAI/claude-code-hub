import { findLatestPriceByModelCached } from "@/lib/cache/model-price-cache";
import { buildModelNameFallbackCandidates } from "@/lib/utils/model-name-matching";
import { findLatestPricesByModels } from "@/repository/model-price";
import type { ModelPrice } from "@/types/model-price";

/**
 * Resolve the latest price row for each requested model id.
 *
 * 1. One batched exact-name query covering every id and its fallback candidates
 *    (provider prefix stripped, gateway suffixes removed, region prefixes removed, lowercase).
 * 2. Remaining misses go through the cached single-model lookup, which also matches aliases.
 *
 * The returned map is keyed by the original id; misses map to null.
 */
export async function resolvePricesForModels(
  ids: string[]
): Promise<Map<string, ModelPrice | null>> {
  const result = new Map<string, ModelPrice | null>();
  if (ids.length === 0) return result;

  const candidatesById = new Map<string, string[]>();
  const names = new Set<string>();
  for (const id of ids) {
    const candidates = [id, ...buildModelNameFallbackCandidates(id)];
    candidatesById.set(id, candidates);
    for (const name of candidates) names.add(name);
  }

  const batch = await findLatestPricesByModels([...names]);

  const misses: string[] = [];
  for (const id of ids) {
    const hit = (candidatesById.get(id) ?? []).map((name) => batch.get(name)).find(Boolean);
    if (hit) {
      result.set(id, hit);
    } else {
      misses.push(id);
    }
  }

  const fallbacks = await Promise.all(misses.map((id) => findLatestPriceByModelCached(id)));
  misses.forEach((id, index) => {
    result.set(id, fallbacks[index] ?? null);
  });

  return result;
}
