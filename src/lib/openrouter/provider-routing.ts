import { z } from "zod";
import type {
  OpenRouterMaxPriceKey,
  OpenRouterProviderRouting,
  OpenRouterQuantization,
  OpenRouterSort,
} from "@/types/provider";
import type { ProviderParameterOverrideSpecialSetting } from "@/types/special-settings";

export const OPENROUTER_QUANTIZATIONS = [
  "int4",
  "int8",
  "fp4",
  "fp6",
  "fp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
] as const satisfies readonly OpenRouterQuantization[];

export const OPENROUTER_SORT_OPTIONS = [
  "price",
  "throughput",
  "latency",
] as const satisfies readonly OpenRouterSort[];

export const OPENROUTER_MAX_PRICE_KEYS = [
  "prompt",
  "completion",
  "request",
  "image",
] as const satisfies readonly OpenRouterMaxPriceKey[];

export const OPENROUTER_PROVIDER_SLUG_MAX_LENGTH = 128;
export const OPENROUTER_PROVIDER_LIST_MAX_ITEMS = 64;

const PROVIDER_SLUG_LIST_SCHEMA = z
  .array(z.string().trim().min(1).max(OPENROUTER_PROVIDER_SLUG_MAX_LENGTH))
  .max(OPENROUTER_PROVIDER_LIST_MAX_ITEMS);

const NON_NEGATIVE_NUMBER_SCHEMA = z.number().finite().nonnegative();

const OPENROUTER_PROVIDER_ROUTING_OBJECT_SCHEMA = z
  .object({
    order: PROVIDER_SLUG_LIST_SCHEMA.optional(),
    only: PROVIDER_SLUG_LIST_SCHEMA.optional(),
    ignore: PROVIDER_SLUG_LIST_SCHEMA.optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["allow", "deny"]).optional(),
    zdr: z.boolean().optional(),
    enforce_distillable_text: z.boolean().optional(),
    quantizations: z.array(z.enum(OPENROUTER_QUANTIZATIONS)).optional(),
    sort: z.enum(OPENROUTER_SORT_OPTIONS).optional(),
    max_price: z
      .object({
        prompt: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
        completion: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
        request: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
        image: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
      })
      .strict()
      .optional(),
    preferred_min_throughput: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
    preferred_max_latency: NON_NEGATIVE_NUMBER_SCHEMA.optional(),
  })
  .strict();

/**
 * Validation schema for create/update payloads.
 * undefined = no change, null = clear, object = normalized (an empty config becomes null).
 */
export const OPENROUTER_PROVIDER_ROUTING_SCHEMA =
  OPENROUTER_PROVIDER_ROUTING_OBJECT_SCHEMA.nullable()
    .optional()
    .transform((value) =>
      value === undefined ? undefined : normalizeOpenRouterProviderRouting(value)
    );

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSlugList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > OPENROUTER_PROVIDER_SLUG_MAX_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= OPENROUTER_PROVIDER_LIST_MAX_ITEMS) break;
  }
  return result.length > 0 ? result : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Lenient normalizer used for both validated input and rows read from the database.
 * Drops unknown keys, invalid values and empty lists. Returns null when nothing is configured.
 */
export function normalizeOpenRouterProviderRouting(
  input: unknown
): OpenRouterProviderRouting | null {
  if (!isPlainObject(input)) return null;

  const result: OpenRouterProviderRouting = {};

  for (const key of ["order", "only", "ignore"] as const) {
    const list = normalizeSlugList(input[key]);
    if (list) result[key] = list;
  }

  for (const key of [
    "allow_fallbacks",
    "require_parameters",
    "zdr",
    "enforce_distillable_text",
  ] as const) {
    const flag = normalizeBoolean(input[key]);
    if (flag !== undefined) result[key] = flag;
  }

  if (input.data_collection === "allow" || input.data_collection === "deny") {
    result.data_collection = input.data_collection;
  }

  if (Array.isArray(input.quantizations)) {
    const requested = input.quantizations as unknown[];
    const quantizations: OpenRouterQuantization[] = OPENROUTER_QUANTIZATIONS.filter((q) =>
      requested.includes(q)
    );
    if (quantizations.length > 0) result.quantizations = quantizations;
  }

  if (
    typeof input.sort === "string" &&
    (OPENROUTER_SORT_OPTIONS as readonly string[]).includes(input.sort)
  ) {
    result.sort = input.sort as OpenRouterSort;
  }

  if (isPlainObject(input.max_price)) {
    const maxPrice: Partial<Record<OpenRouterMaxPriceKey, number>> = {};
    for (const key of OPENROUTER_MAX_PRICE_KEYS) {
      const price = normalizeNonNegativeNumber(input.max_price[key]);
      if (price !== undefined) maxPrice[key] = price;
    }
    if (Object.keys(maxPrice).length > 0) result.max_price = maxPrice;
  }

  for (const key of ["preferred_min_throughput", "preferred_max_latency"] as const) {
    const num = normalizeNonNegativeNumber(input[key]);
    if (num !== undefined) result[key] = num;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Provider types whose request body is an OpenAI / Anthropic style JSON object with a
 * free-form top level. Gemini generateContent bodies are excluded.
 */
export function supportsOpenRouterProviderRouting(providerType: string | null | undefined) {
  return providerType !== "gemini" && providerType !== "gemini-cli";
}

export function hasOpenRouterProviderRouting(provider: {
  readonly providerType?: string;
  readonly openrouterProviderRouting?: OpenRouterProviderRouting | null;
}): boolean {
  return (
    supportsOpenRouterProviderRouting(provider.providerType) &&
    normalizeOpenRouterProviderRouting(provider.openrouterProviderRouting) !== null
  );
}

type OpenRouterRoutingProviderConfig = {
  readonly id?: number;
  readonly name?: string;
  readonly providerType?: string;
  readonly openrouterProviderRouting?: OpenRouterProviderRouting | null;
};

/**
 * Merge provider-level OpenRouter routing preferences into the request `provider` field.
 * Client-sent keys are kept unless the provider configures the same key; `max_price` is
 * merged per price key. Returns the same object reference when nothing applies.
 */
export function applyOpenRouterProviderRouting(
  provider: OpenRouterRoutingProviderConfig,
  request: Record<string, unknown>
): { request: Record<string, unknown>; audit: ProviderParameterOverrideSpecialSetting | null } {
  if (!supportsOpenRouterProviderRouting(provider.providerType)) {
    return { request, audit: null };
  }
  const config = normalizeOpenRouterProviderRouting(provider.openrouterProviderRouting);
  if (!config) {
    return { request, audit: null };
  }

  const clientProvider = isPlainObject(request.provider) ? request.provider : null;
  const merged: Record<string, unknown> = { ...(clientProvider ?? {}), ...config };
  if (config.max_price && isPlainObject(clientProvider?.max_price)) {
    merged.max_price = { ...clientProvider.max_price, ...config.max_price };
  }

  const before = clientProvider ? JSON.stringify(clientProvider) : null;
  const after = JSON.stringify(merged);

  return {
    request: { ...request, provider: merged },
    audit: {
      type: "provider_parameter_override",
      scope: "provider",
      providerId: provider.id ?? null,
      providerName: provider.name ?? null,
      providerType: provider.providerType ?? null,
      hit: true,
      changed: before !== after,
      changes: [{ path: "provider", before, after, changed: before !== after }],
    },
  };
}
