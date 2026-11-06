import { logger } from "@/lib/logger";
import { matchesProviderPrefix, stripProviderPrefix } from "@/lib/provider-prefix";
import builtinCatalog from "./data/codex-builtin-models.json";
import deepseekCatalog from "./data/deepseek-models.json";
import {
  type CodexCatalogModel,
  CodexCatalogModelSchema,
  describeCodexCatalogIssue,
} from "./schema";

/**
 * Built-in Codex model entries used as metadata templates.
 *
 * Sources:
 * - `codex-rs/models-manager/models.json` from openai/codex (see `data/SOURCE`).
 * - Vendor catalogs written for Codex by the vendor itself, e.g. DeepSeek's
 *   `~/.codex/models.json` (see `data/deepseek-models.SOURCE`).
 * Each entry carries the full system prompt (`model_messages.instructions_template`)
 * and tool configuration that make the model behave correctly inside Codex, so the
 * gateway copies a template instead of inventing metadata.
 */

export type TemplateMatch = "exact" | "prefix" | "vendor" | "family" | "fallback";

/**
 * Vendor catalogs number their models from 1 because they assume a vendor-only list. Shift them
 * behind every Codex built-in (max 43) so a vendor model never becomes Codex's default model for
 * a key that can also use the built-in GPT models; a key with only vendor models still gets the
 * vendor's own order.
 */
export const VENDOR_TEMPLATE_PRIORITY_OFFSET = 100;

export interface VendorFamily {
  name: string;
  raw: unknown;
  /** Bare slugs of this vendor's series (any version, any casing). */
  matches: RegExp;
  /** Ordered rules for series members without their own entry; first hit wins. */
  rules: readonly { pattern: RegExp; slug: string }[];
  /** Template for every other series member. Pick the most conservative entry. */
  defaultSlug: string;
}

/**
 * Vendor catalogs merged after the Codex built-ins (built-ins win on a slug conflict).
 *
 * DeepSeek ships entries for `deepseek-flash` (text + image) and `deepseek-v4-pro` (text only).
 * Every other DeepSeek model (`deepseek-chat`, `deepseek-reasoner`, `DeepSeek-V3.2`,
 * `deepseek-v4-flash`, ...) gets DeepSeek's metadata instead of GPT's: flash / vision / VL
 * variants use the image-capable entry, everything else the text-only one, because declaring
 * image input for a text-only model makes the upstream reject image turns.
 */
export const VENDOR_FAMILIES: readonly VendorFamily[] = [
  {
    name: "deepseek",
    raw: deepseekCatalog,
    matches: /^deepseek(?:[-_.:]|$)/i,
    rules: [{ pattern: /flash|vision|(?:^|[-_.])vl\d*(?:[-_.]|$)/i, slug: "deepseek-flash" }],
    defaultSlug: "deepseek-v4-pro",
  },
];

/**
 * Priority added to vendor series members matched by rule, so they list right after the vendor's
 * own entries and before models that only got the generic fallback.
 */
export const VENDOR_FAMILY_PRIORITY_BUMP = 50;

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

/**
 * Merge Codex built-ins with vendor templates. Built-ins come first, so they win on a slug
 * conflict and remain the source of the generic fallback template.
 */
export function mergeTemplates(
  builtins: readonly CodexCatalogModel[],
  vendors: readonly CodexCatalogModel[][]
): CodexCatalogModel[] {
  const merged = [...builtins];
  const seen = new Set(builtins.map((template) => template.slug.toLowerCase()));
  for (const vendor of vendors) {
    for (const template of vendor) {
      const slug = template.slug.toLowerCase();
      if (seen.has(slug)) continue;
      seen.add(slug);
      merged.push({
        ...template,
        priority: template.priority + VENDOR_TEMPLATE_PRIORITY_OFFSET,
      });
    }
  }
  return merged;
}

/** Lazily validate the bundled templates once per process. */
export function loadBuiltinTemplates(): readonly CodexCatalogModel[] {
  if (!memoizedTemplates) {
    memoizedTemplates = Object.freeze(
      mergeTemplates(
        parseTemplates(builtinCatalog),
        VENDOR_FAMILIES.map((family) => parseTemplates(family.raw))
      )
    );
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

function pickFirstListed(templates: readonly CodexCatalogModel[]): CodexCatalogModel | null {
  let best: CodexCatalogModel | null = null;
  for (const template of templates) {
    if (template.visibility !== "list") continue;
    if (!best || template.priority < best.priority) best = template;
  }
  return best;
}

/** Lowest-priority (= first in picker) template that is listed; else the first template. */
export function pickFallbackTemplate(
  templates: readonly CodexCatalogModel[]
): CodexCatalogModel | null {
  return pickFirstListed(templates) ?? templates[0] ?? null;
}

/** First dash-separated segment, the model family (`deepseek-v4-flash` -> `deepseek`). */
export function modelFamily(slug: string): string | null {
  const dash = slug.indexOf("-");
  return dash > 0 ? slug.slice(0, dash).toLowerCase() : null;
}

function isBoundaryPrefix(bare: string, slug: string): boolean {
  if (!bare.startsWith(slug) || bare.length === slug.length) return false;
  const next = bare.charAt(slug.length);
  return next === "-" || next === "." || next === ":" || next === "@";
}

/** Resolve a vendor series member (e.g. any `deepseek*` model) to one of the vendor's templates. */
export function findVendorFamilyTemplate(
  bareSlug: string,
  templates: readonly CodexCatalogModel[],
  families: readonly VendorFamily[] = VENDOR_FAMILIES
): CodexCatalogModel | null {
  for (const family of families) {
    if (!family.matches.test(bareSlug)) continue;
    const rule = family.rules.find((candidate) => candidate.pattern.test(bareSlug));
    const slug = (rule?.slug ?? family.defaultSlug).toLowerCase();
    const template = templates.find((candidate) => candidate.slug.toLowerCase() === slug);
    if (template) return template;
  }
  return null;
}

/**
 * Pick the template for a bare slug: exact match, then the longest built-in slug that is a
 * boundary-aware prefix (`gpt-6.1-sol-fast` -> `gpt-6.1-sol`), then a vendor series rule
 * (`deepseek-chat` -> `deepseek-v4-pro`), then the first listed template of the same family
 * (`gpt-60` -> `gpt-6.1-sol`), then the fallback template.
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

  const vendorMatch = findVendorFamilyTemplate(bareSlug, templates);
  if (vendorMatch) return { template: vendorMatch, match: "vendor" };

  const family = modelFamily(bare);
  if (family) {
    const familyMatch = pickFirstListed(
      templates.filter((template) => modelFamily(template.slug) === family)
    );
    if (familyMatch) return { template: familyMatch, match: "family" };
  }

  const fallback = pickFallbackTemplate(templates);
  return fallback ? { template: fallback, match: "fallback" } : null;
}
