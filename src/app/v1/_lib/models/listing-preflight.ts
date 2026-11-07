import { checkUserClient } from "@/app/v1/_lib/proxy/client-guard";
import { ProxyProviderResolver } from "@/app/v1/_lib/proxy/provider-selector";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { isClientVersionRejected } from "@/app/v1/_lib/proxy/version-guard";
import { TTLMap } from "@/lib/cache/ttl-map";
import { logger } from "@/lib/logger";
import type { Provider } from "@/types/provider";

/**
 * Request-path checks a model listing replays so it only advertises models the caller can use.
 *
 * Mirrors the proxy guard chain for everything that does not depend on the request body:
 * - user-level client restrictions (ProxyClientGuard) and the client version gate
 *   (ProxyVersionGuard): when either rejects the client, no model is usable;
 * - provider health (ProviderSelector.filterByLimits): open circuits (provider and vendor+type),
 *   provider spend limits and exhausted/low upstream quota remove a provider from routing.
 */

export interface ListingPreflightUser {
  allowedClients?: string[] | null;
  blockedClients?: string[] | null;
}

/** Whether the user-level client gate or the version gate rejects this client outright. */
export async function isListingClientRejected(
  subject: ProxySession,
  user: ListingPreflightUser
): Promise<boolean> {
  if (!checkUserClient(subject, user).allowed) return true;
  return isClientVersionRejected(subject.userAgent ?? null);
}

/** Health verdicts are reused this long; the router's own spend verdicts live 2-5 s. */
export const LISTING_HEALTH_TTL_MS = 2_000;

const healthCache = new TTLMap<string, ReadonlySet<number>>({
  ttlMs: LISTING_HEALTH_TTL_MS,
  maxSize: 200,
});

/**
 * Providers the router would currently skip for health or limit reasons. Errors fail open
 * (nothing removed), like the router's own checks, so a Redis hiccup never empties a listing.
 */
export async function findUnhealthyProviderIds(
  providers: readonly Provider[]
): Promise<ReadonlySet<number>> {
  if (providers.length === 0) return new Set();
  const cacheKey = providers
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join(".");
  const cached = healthCache.get(cacheKey);
  if (cached) return cached;

  let unhealthy: ReadonlySet<number>;
  try {
    const healthy = await ProxyProviderResolver.filterByLimits([...providers]);
    const healthyIds = new Set(healthy.map((p) => p.id));
    unhealthy = new Set(providers.filter((p) => !healthyIds.has(p.id)).map((p) => p.id));
  } catch (error) {
    logger.warn("[ListingPreflight] Provider health check failed, listing all providers", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
  healthCache.set(cacheKey, unhealthy);
  return unhealthy;
}

export function resetListingPreflightForTests(): void {
  healthCache.clear();
}
