import { getAvailableModelsGroupedByProviderType } from "@/app/v1/_lib/models/available-models";
import { logger } from "@/lib/logger";
import { filterChatCapableModels } from "@/lib/model-endpoint-capability";
import { normalizeProviderPrefix } from "@/lib/provider-prefix";
import { findAllProviders } from "@/repository/provider";
import { buildCodexCatalogModels, serializeCodexCatalog } from "./build";
import {
  buildCodexCatalogCacheKey,
  type CachedCodexCatalog,
  type CodexCatalogAuthState,
  getOrBuildCodexCatalog,
} from "./cache";
import { loadBuiltinTemplates } from "./templates";

export * from "./build";
export * from "./cache";
export * from "./schema";
export * from "./templates";

/** Provider type whose models are listed: the providers that serve /v1/responses. */
const CODEX_PROVIDER_TYPE = "codex" as const;

/** Builds above this duration are logged; Codex aborts the whole fetch after 5 s. */
const SLOW_BUILD_WARN_MS = 2_000;

async function collectCodexProviderPrefixes(): Promise<string[]> {
  const providers = await findAllProviders();
  const prefixes = new Set<string>();
  for (const provider of providers) {
    if (provider.providerType !== CODEX_PROVIDER_TYPE) continue;
    const prefix = normalizeProviderPrefix(provider.providerPrefix);
    if (prefix) prefixes.add(prefix);
  }
  // Longest first so nested prefixes (`openai/test/` vs `openai/`) strip as much as possible.
  return [...prefixes].sort((a, b) => b.length - a.length);
}

/**
 * Build the Codex catalog for an auth scope (uncached).
 *
 * Slugs are exactly the model ids that /v1/responses routes for this caller (codex providers
 * after provider group, schedule, allowedModels, providerPrefix and user allowedModels), so
 * every listed slug is accepted by the proxy as-is.
 */
export async function computeCodexCatalog(
  auth: CodexCatalogAuthState
): Promise<Omit<CachedCodexCatalog, "builtAt">> {
  const startedAt = Date.now();
  const [{ groups }, providerPrefixes] = await Promise.all([
    getAvailableModelsGroupedByProviderType(auth, [CODEX_PROVIDER_TYPE]),
    collectCodexProviderPrefixes(),
  ]);

  // Codex only calls /v1/responses: image-generation-only models would fail every turn.
  const gatewayIds = groups.flatMap((group) =>
    filterChatCapableModels(group.models).map((model) => model.id)
  );
  const displayNameOverrides = new Map<string, string>();
  for (const group of groups) {
    for (const model of group.models) {
      if (model.displayNameOverride && !displayNameOverrides.has(model.id)) {
        displayNameOverrides.set(model.id, model.displayNameOverride);
      }
    }
  }
  const models = buildCodexCatalogModels(
    { gatewayIds, providerPrefixes, displayNameOverrides },
    loadBuiltinTemplates()
  );
  const { body, etag } = serializeCodexCatalog(models);

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > SLOW_BUILD_WARN_MS) {
    logger.warn(
      "[CodexCatalog] Slow catalog build; configure allowedModels on codex providers to avoid upstream model fetches",
      { userId: auth.user.id, elapsedMs }
    );
  }

  return { body, etag, modelCount: models.length };
}

/** Cached catalog for an auth scope (single-flight, 60 s soft TTL). */
export function getCodexCatalog(auth: CodexCatalogAuthState): Promise<CachedCodexCatalog> {
  return getOrBuildCodexCatalog(buildCodexCatalogCacheKey(auth), () => computeCodexCatalog(auth));
}
