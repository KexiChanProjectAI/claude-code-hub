import { describe, expect, it } from "vitest";
import { deriveModalities, toCatalogMetadata, toPerMillion } from "@/lib/model-catalog/metadata";
import type { ModelPriceData } from "@/types/model-price";

describe("toPerMillion", () => {
  it("converts per-token USD to per-1M and strips float noise", () => {
    expect(toPerMillion(0.000003)).toBe(3);
    expect(toPerMillion(0.0000003)).toBe(0.3);
    expect(toPerMillion(3.75e-6)).toBe(3.75);
    expect(toPerMillion(0)).toBe(0);
  });

  it("returns null for missing, negative or non-finite values", () => {
    expect(toPerMillion(undefined)).toBeNull();
    expect(toPerMillion("3")).toBeNull();
    expect(toPerMillion(-1)).toBeNull();
    expect(toPerMillion(Number.NaN)).toBeNull();
  });
});

describe("toCatalogMetadata", () => {
  const price: ModelPriceData = {
    display_name: "Claude Sonnet 4.5",
    vendor: "anthropic",
    vendor_icon: "anthropic.svg",
    vendor_icon_mono: true,
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    supports_vision: true,
    supports_function_calling: true,
    supports_reasoning: true,
    supports_pdf_input: true,
    supports_prompt_caching: true,
    knowledge_cutoff: "2025-03",
    deprecated: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  };

  it("maps every field from the price table", () => {
    expect(toCatalogMetadata(price, { id: "claude-sonnet-4-5" })).toEqual({
      displayName: "Claude Sonnet 4.5",
      vendor: "anthropic",
      vendorIcon: "anthropic.svg",
      vendorIconMono: true,
      contextWindow: 200000,
      maxOutputTokens: 64000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: {
        vision: true,
        functionCalling: true,
        reasoning: true,
        pdfInput: true,
        promptCaching: true,
      },
      modalities: { input: ["text", "image"], output: ["text"] },
      knowledgeCutoff: "2025-03",
      deprecated: true,
      hasPriceData: true,
    });
  });

  it("falls back to max_tokens and treats vendor 'other' as unknown", () => {
    const result = toCatalogMetadata(
      { max_tokens: 8192, vendor: "other" },
      { id: "mystery-model-1" }
    );
    expect(result.maxOutputTokens).toBe(8192);
    expect(result.vendor).toBeNull();
    expect(result.displayName).toBe("mystery-model-1");
    expect(result.pricing).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    });
    expect(result.capabilities?.vision).toBe(false);
  });

  it("infers the vendor and nulls price-derived fields when there is no price row", () => {
    const result = toCatalogMetadata(null, { id: "gpt-5", displayName: "GPT-5" });
    expect(result).toMatchObject({
      displayName: "GPT-5",
      vendor: "openai",
      pricing: null,
      capabilities: null,
      modalities: null,
      contextWindow: null,
      hasPriceData: false,
      deprecated: false,
    });
  });

  it("returns a null vendor when inference fails without a price row", () => {
    expect(toCatalogMetadata(null, { id: "zzzz-unknown" }).vendor).toBeNull();
  });
});

describe("deriveModalities", () => {
  it("prefers stored modalities", () => {
    expect(deriveModalities({ modalities: { input: ["audio"], output: ["audio"] } })).toEqual({
      input: ["audio"],
      output: ["audio"],
    });
  });

  it("derives from capability flags when nothing is stored", () => {
    expect(
      deriveModalities({
        supports_vision: true,
        supports_pdf_input: true,
        supports_audio_input: true,
        supports_video_input: true,
        supports_audio_output: true,
      })
    ).toEqual({ input: ["text", "image", "pdf", "audio", "video"], output: ["text", "audio"] });
    expect(deriveModalities({ mode: "image_generation", modalities: { input: [] } })).toEqual({
      input: ["text"],
      output: ["image"],
    });
  });
});
