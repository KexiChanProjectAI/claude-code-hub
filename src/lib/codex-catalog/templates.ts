import { logger } from "@/lib/logger";
import { matchesProviderPrefix, stripProviderPrefix } from "@/lib/provider-prefix";
import builtinCatalog from "./data/codex-builtin-models.json";
import {
  type CodexCatalogModel,
  CodexCatalogModelSchema,
  describeCodexCatalogIssue,
} from "./schema";

/**
 * Built-in Codex model entries used as metadata templates.
 *
 * Source: `codex-rs/models-manager/models.json` from openai/codex (see `data/SOURCE`).
 * Each entry carries the full system prompt (`model_messages.instructions_template`)
 * and tool configuration that make the model behave correctly inside Codex, so the
 * gateway copies a template instead of inventing metadata.
 */

export type TemplateMatch = "exact" | "prefix" | "fallback";

let memoizedTemplates: readonly CodexCatalogModel[] | null = null;

/** Validate raw template entries; invalid entries are dropped with a warning. */
export function parseTemplates(raw: unknown): CodexCatalogModel[] {
  const entries =
    raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
      ? ((raw as { models: unknown[] }).models as unknown[])
      : [];

  const templates: CodexCatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = CodexCatalogModelSchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn("[CodexCatalog] Dropping invalid built-in template", {
        slug: (entry as { slug?: unknown } | null)?.slug,
        reason: describeCodexCatalogIssue(parsed.error),
      });
      continue;
    }
    if (seen.has(parsed.data.slug)) continue;
    seen.add(parsed.data.slug);
    templates.push(parsed.data);
  }
  return templates;
}

/** Lazily validate the bundled templates once per process. */
export function loadBuiltinTemplates(): readonly CodexCatalogModel[] {
  if (!memoizedTemplates) {
    memoizedTemplates = Object.freeze(parseTemplates(builtinCatalog));
  }
  return memoizedTemplates;
}

export function resetBuiltinTemplatesForTests(): void {
  memoizedTemplates = null;
}

/**
 * Derive the bare model name used for template lookup.
 *
 * Strips the first matching provider prefix (e.g. `openai/`), otherwise falls back to
 * the segment after the last `/` so namespaced ids such as `openai/test/gpt-6.1-sol`
 * still resolve to `gpt-6.1-sol`.
 */
export function deriveBareSlug(gatewayId: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    if (matchesProviderPrefix(gatewayId, prefix)) {
      const stripped = stripProviderPrefix(gatewayId, prefix);
      return stripped.includes("/") ? stripped.slice(stripped.lastIndexOf("/") + 1) : stripped;
    }
  }
  const lastSlash = gatewayId.lastIndexOf("/");
  return lastSlash >= 0 ? gatewayId.slice(lastSlash + 1) : gatewayId;
}

/** Lowest-priority (= first in picker) template that is listed; else the first template. */
export function pickFallbackTemplate(
  templates: readonly CodexCatalogModel[]
): CodexCatalogModel | null {
  let best: CodexCatalogModel | null = null;
  for (const template of templates) {
    if (template.visibility !== "list") continue;
    if (!best || template.priority < best.priority) best = template;
  }
  return best ?? templates[0] ?? null;
}

function isBoundaryPrefix(bare: string, slug: string): boolean {
  if (!bare.startsWith(slug) || bare.length === slug.length) return false;
  const next = bare.charAt(slug.length);
  return next === "-" || next === "." || next === ":" || next === "@";
}

/**
 * Pick the template for a bare slug: exact match, then the longest built-in slug that is a
 * boundary-aware prefix (`gpt-6.1-sol-fast` -> `gpt-6.1-sol`), then the fallback template.
 * Matching is case-insensitive; the gateway id itself is always emitted verbatim.
 */
export function findTemplateForSlug(
  bareSlug: string,
  templates: readonly CodexCatalogModel[]
): { template: CodexCatalogModel; match: TemplateMatch } | null {
  const bare = bareSlug.toLowerCase();

  const exact = templates.find((template) => template.slug.toLowerCase() === bare);
  if (exact) return { template: exact, match: "exact" };

  let prefixMatch: CodexCatalogModel | null = null;
  for (const template of templates) {
    const slug = template.slug.toLowerCase();
    if (!isBoundaryPrefix(bare, slug)) continue;
    if (!prefixMatch || slug.length > prefixMatch.slug.length) prefixMatch = template;
  }
  if (prefixMatch) return { template: prefixMatch, match: "prefix" };

  const fallback = pickFallbackTemplate(templates);
  return fallback ? { template: fallback, match: "fallback" } : null;
}
