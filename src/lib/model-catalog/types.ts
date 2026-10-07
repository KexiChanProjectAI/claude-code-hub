import type { ClientFormat } from "@/app/v1/_lib/proxy/format-mapper";

/** Protocol ids are the proxy's inbound client formats (same values as `/v1/models?format=`). */
export type CatalogProtocolId = ClientFormat;

/** Base-tier prices in USD per 1M tokens. Null when the price table has no value. */
export interface CatalogPricing {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface CatalogCapabilities {
  vision: boolean;
  functionCalling: boolean;
  reasoning: boolean;
  pdfInput: boolean;
  promptCaching: boolean;
}

export interface CatalogModalities {
  input: string[];
  output: string[];
}

export interface CatalogModel {
  /** The model id clients send in requests (provider prefix included when configured). */
  id: string;
  displayName: string;
  /** Model vendor slug (anthropic, openai, google, ...). Never the upstream provider. */
  vendor: string | null;
  vendorName: string | null;
  vendorIcon: string | null;
  vendorIconMono: boolean;
  protocols: CatalogProtocolId[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: CatalogPricing | null;
  capabilities: CatalogCapabilities | null;
  modalities: CatalogModalities | null;
  knowledgeCutoff: string | null;
  deprecated: boolean;
  hasPriceData: boolean;
}

export interface CatalogProtocol {
  id: CatalogProtocolId;
  label: string;
  endpointPath: string;
  models: string[];
}

export interface ModelCatalog {
  generatedAt: string;
  models: CatalogModel[];
  protocols: CatalogProtocol[];
  /** Admin-authored markdown for agents. Null when unset. */
  notes: string | null;
}

export interface CatalogAuthState {
  user: { id: number; providerGroup: string | null; allowedModels?: string[] | null };
  key: { providerGroup: string | null };
}
