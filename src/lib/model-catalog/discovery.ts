import type { ProtocolHint } from "@/app/v1/_lib/unprefixed-v1-alias";
import type { CodexCatalogModel } from "@/lib/codex-catalog/schema";
import {
  deriveBareSlug,
  findTemplateForSlug,
  loadBuiltinTemplates,
} from "@/lib/codex-catalog/templates";
import { inferVendorFromModelName, UNKNOWN_VENDOR } from "@/lib/model-vendor/vendor-inference";
import { buildModelCatalog } from "./build";
import type { CatalogAuthState, CatalogModel } from "./types";

/**
 * Per-protocol model discovery rows for clients that read model metadata from `/models`
 * (omp `openai-models-list` discovery). The outer shape stays the OpenAI list; each row adds
 * the fields those clients read: `metadata.display_name`, `context_length`, `max_output_tokens`
 * (mirrored as `limits.max_output_tokens`), `input_modalities`, `output_modalities` and the
 * reasoning fields. Verified against omp 18.17.0 (reads all of them) and 18.10.1 (reads only
 * context, `limits.max_output_tokens` and modalities; name and reasoning come from its built-ins).
 *
 * Sources, per field:
 * - numeric limits: the price table, else a curated Codex template (Codex built-ins, DeepSeek).
 * - capabilities (image input, reasoning levels): a curated template when the model matches one
 *   (exact, prefix or vendor-series match), else the price table.
 * A field with no source is omitted rather than guessed, so the client can fall back to its own
 * built-in metadata for well-known model ids.
 */

/** Reasoning levels these clients understand; others (e.g. `minimal`, `ultra`) are ignored. */
const DISCOVERY_REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** Levels offered when only the price table says the model reasons. */
const GENERIC_REASONING_LEVELS = ["low", "medium", "high"] as const;
const GENERIC_DEFAULT_REASONING_LEVEL = "medium";

export interface DiscoveryRow {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata: { display_name: string };
  context_length?: number;
  max_output_tokens?: number;
  /** Same value as `max_output_tokens`; older omp releases (<= 18.10) read only this one. */
  limits?: { max_output_tokens: number };
  input_modalities?: string[];
  output_modalities?: string[];
  supported_reasoning_levels?: string[];
  default_reasoning_level?: string;
  reasoning?: false;
}

function curatedTemplate(
  modelId: string,
  templates: readonly CodexCatalogModel[]
): CodexCatalogModel | null {
  const found = findTemplateForSlug(deriveBareSlug(modelId, []), templates);
  if (!found) return null;
  return found.match === "exact" || found.match === "prefix" || found.match === "vendor"
    ? found.template
    : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item !== "");
  return items.length > 0 ? items : undefined;
}

function applyReasoning(
  row: DiscoveryRow,
  model: CatalogModel,
  template: CodexCatalogModel | null
): void {
  if (template) {
    const levels = template.supported_reasoning_levels
      .map((level) => level.effort)
      .filter((effort) => DISCOVERY_REASONING_LEVELS.has(effort));
    if (levels.length === 0) {
      row.reasoning = false;
      return;
    }
    row.supported_reasoning_levels = levels;
    const preferred = template.default_reasoning_level;
    if (typeof preferred === "string" && levels.includes(preferred)) {
      row.default_reasoning_level = preferred;
    }
    return;
  }

  if (!model.hasPriceData || !model.capabilities) return;
  if (model.capabilities.reasoning) {
    row.supported_reasoning_levels = [...GENERIC_REASONING_LEVELS];
    row.default_reasoning_level = GENERIC_DEFAULT_REASONING_LEVEL;
  } else {
    row.reasoning = false;
  }
}

export function toDiscoveryRow(
  model: CatalogModel,
  templates: readonly CodexCatalogModel[],
  created: number
): DiscoveryRow {
  const template = curatedTemplate(model.id, templates);
  const inferred = inferVendorFromModelName(model.id);
  const ownedBy = model.vendor ?? (inferred === UNKNOWN_VENDOR ? "unknown" : inferred);
  const displayName =
    model.displayName === model.id && template && deriveBareSlug(model.id, []) === template.slug
      ? template.display_name
      : model.displayName;

  const row: DiscoveryRow = {
    id: model.id,
    object: "model",
    created,
    owned_by: ownedBy,
    metadata: { display_name: displayName },
  };

  const contextLength = positive(model.contextWindow) ?? positive(template?.context_window);
  if (contextLength) row.context_length = contextLength;
  const maxOutput = positive(model.maxOutputTokens);
  if (maxOutput) {
    row.max_output_tokens = contextLength ? Math.min(maxOutput, contextLength) : maxOutput;
    row.limits = { max_output_tokens: row.max_output_tokens };
  }

  const inputModalities =
    stringArray(template?.input_modalities) ?? stringArray(model.modalities?.input);
  if (inputModalities) row.input_modalities = inputModalities;
  const outputModalities = stringArray(model.modalities?.output);
  if (outputModalities) row.output_modalities = outputModalities;

  applyReasoning(row, model, template);
  return row;
}

/** Models reachable on one protocol for this caller, as discovery rows. */
export async function buildProtocolModelList(
  auth: CatalogAuthState,
  protocol: ProtocolHint
): Promise<{ object: "list"; data: DiscoveryRow[] }> {
  const catalog = await buildModelCatalog(auth);
  const templates = loadBuiltinTemplates();
  const created = Math.floor(Date.now() / 1000);
  const data = catalog.models
    .filter((model) => model.protocols.includes(protocol))
    .map((model) => toDiscoveryRow(model, templates, created));
  return { object: "list", data };
}
