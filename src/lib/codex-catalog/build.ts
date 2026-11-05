import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  type CodexCatalogModel,
  CodexCatalogModelSchema,
  describeCodexCatalogIssue,
} from "./schema";
import { deriveBareSlug, findTemplateForSlug } from "./templates";

/**
 * Priority for models that only matched the fallback template. Codex picks the first listed
 * model as its default, so models without their own metadata sort after every built-in one.
 */
export const CODEX_FALLBACK_PRIORITY = 1000;

export interface CodexCatalogInput {
  /** Gateway model ids routable via /v1/responses for the caller, emitted verbatim as slugs. */
  gatewayIds: readonly string[];
  /** Normalized provider prefixes of codex providers (e.g. `openai/`). */
  providerPrefixes: readonly string[];
}

/**
 * Build one catalog entry from the matching template.
 *
 * Every template field (system prompt, tool config, reasoning levels, ...) is kept so the
 * model behaves exactly like the built-in one; only identity fields are replaced.
 */
export function buildCodexCatalogEntry(
  gatewayId: string,
  templates: readonly CodexCatalogModel[],
  providerPrefixes: readonly string[]
): CodexCatalogModel | null {
  const bare = deriveBareSlug(gatewayId, providerPrefixes);
  const found = findTemplateForSlug(bare, templates);
  if (!found) return null;

  const { template, match } = found;
  const cloned = structuredClone(template) as CodexCatalogModel;
  return {
    ...cloned,
    slug: gatewayId,
    display_name: match === "exact" ? template.display_name : gatewayId,
    priority:
      match === "fallback"
        ? Math.max(CODEX_FALLBACK_PRIORITY, template.priority)
        : template.priority,
    supported_in_api: true,
  };
}

/**
 * Build, validate, dedupe and order catalog entries.
 *
 * Codex rejects the WHOLE catalog when any entry is invalid or a slug repeats, so invalid
 * entries are dropped (with a warning) and only the first occurrence of a slug is kept.
 */
export function buildCodexCatalogModels(
  input: CodexCatalogInput,
  templates: readonly CodexCatalogModel[]
): CodexCatalogModel[] {
  const models: CodexCatalogModel[] = [];
  const seen = new Set<string>();

  for (const rawId of input.gatewayIds) {
    const gatewayId = typeof rawId === "string" ? rawId : "";
    if (!gatewayId || seen.has(gatewayId)) continue;

    const entry = buildCodexCatalogEntry(gatewayId, templates, input.providerPrefixes);
    if (!entry) {
      logger.warn("[CodexCatalog] No template available for model", { slug: gatewayId });
      continue;
    }

    const parsed = CodexCatalogModelSchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn("[CodexCatalog] Dropping invalid catalog entry", {
        slug: gatewayId,
        reason: describeCodexCatalogIssue(parsed.error),
      });
      continue;
    }

    seen.add(gatewayId);
    models.push(parsed.data);
  }

  return models.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

/**
 * Serialize the catalog and derive its strong ETag.
 *
 * Codex compares the catalog `ETag` with `X-Models-Etag` on /v1/responses byte for byte,
 * so the value is a content hash and both headers reuse this exact string.
 */
export function serializeCodexCatalog(models: readonly CodexCatalogModel[]): {
  body: string;
  etag: string;
} {
  const body = JSON.stringify({ models });
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return { body, etag: `"cch-codex-${digest}"` };
}
