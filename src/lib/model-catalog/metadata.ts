import { inferVendorFromModelName, UNKNOWN_VENDOR } from "@/lib/model-vendor/vendor-inference";
import type { ModelPriceData } from "@/types/model-price";
import type { CatalogModalities, CatalogModel, CatalogPricing } from "./types";

export type CatalogModelMetadata = Omit<CatalogModel, "id" | "protocols" | "vendorName">;

/** Per-token USD -> per-1M-token USD, rounded to strip float noise. */
export function toPerMillion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Number((value * 1_000_000).toFixed(6));
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

export function deriveModalities(price: ModelPriceData): CatalogModalities {
  const stored = price.modalities;
  if (stored && typeof stored === "object") {
    const input = stringList(stored.input);
    const output = stringList(stored.output);
    if (input.length > 0 || output.length > 0) {
      return { input, output };
    }
  }

  const input = ["text"];
  if (price.supports_vision === true) input.push("image");
  if (price.supports_pdf_input === true) input.push("pdf");
  if (price.supports_audio_input === true) input.push("audio");
  if (price.supports_video_input === true) input.push("video");

  const output = price.mode === "image_generation" ? ["image"] : ["text"];
  if (price.supports_audio_output === true) output.push("audio");

  return { input, output };
}

function toPricing(price: ModelPriceData): CatalogPricing {
  return {
    input: toPerMillion(price.input_cost_per_token),
    output: toPerMillion(price.output_cost_per_token),
    cacheRead: toPerMillion(price.cache_read_input_token_cost),
    cacheWrite: toPerMillion(price.cache_creation_input_token_cost),
  };
}

/**
 * Map a price-table row onto catalog metadata. `price` is null when the model has no price row;
 * vendor is then inferred from the model id and every price-derived field is null.
 */
export function toCatalogMetadata(
  price: ModelPriceData | null,
  fallback: { id: string; displayName?: string }
): CatalogModelMetadata {
  const inferred = inferVendorFromModelName(fallback.id);
  const vendor = nonEmptyString(price?.vendor) ?? (inferred === UNKNOWN_VENDOR ? null : inferred);
  const displayName =
    nonEmptyString(price?.display_name) ?? nonEmptyString(fallback.displayName) ?? fallback.id;

  if (!price) {
    return {
      displayName,
      vendor,
      vendorIcon: null,
      vendorIconMono: false,
      contextWindow: null,
      maxOutputTokens: null,
      pricing: null,
      capabilities: null,
      modalities: null,
      knowledgeCutoff: null,
      deprecated: false,
      hasPriceData: false,
    };
  }

  return {
    displayName,
    vendor: vendor === UNKNOWN_VENDOR ? null : vendor,
    vendorIcon: nonEmptyString(price.vendor_icon),
    vendorIconMono: price.vendor_icon_mono === true,
    contextWindow: positiveInt(price.max_input_tokens),
    maxOutputTokens: positiveInt(price.max_output_tokens) ?? positiveInt(price.max_tokens),
    pricing: toPricing(price),
    capabilities: {
      vision: price.supports_vision === true,
      functionCalling: price.supports_function_calling === true,
      reasoning: price.supports_reasoning === true,
      pdfInput: price.supports_pdf_input === true,
      promptCaching: price.supports_prompt_caching === true,
    },
    modalities: deriveModalities(price),
    knowledgeCutoff: nonEmptyString(price.knowledge_cutoff),
    deprecated: price.deprecated === true,
    hasPriceData: true,
  };
}
