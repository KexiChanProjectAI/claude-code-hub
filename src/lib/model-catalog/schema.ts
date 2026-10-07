import { z } from "zod";

const ProtocolIdSchema = z.enum(["claude", "response", "openai", "gemini", "gemini-cli"]);

export const CatalogModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  vendor: z.string().nullable(),
  vendorName: z.string().nullable(),
  vendorIcon: z.string().nullable(),
  vendorIconMono: z.boolean(),
  protocols: z.array(ProtocolIdSchema),
  contextWindow: z.number().int().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  pricing: z
    .object({
      input: z.number().nullable(),
      output: z.number().nullable(),
      cacheRead: z.number().nullable(),
      cacheWrite: z.number().nullable(),
    })
    .nullable(),
  capabilities: z
    .object({
      vision: z.boolean(),
      functionCalling: z.boolean(),
      reasoning: z.boolean(),
      pdfInput: z.boolean(),
      promptCaching: z.boolean(),
    })
    .nullable(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).nullable(),
  knowledgeCutoff: z.string().nullable(),
  deprecated: z.boolean(),
  hasPriceData: z.boolean(),
});

export const ModelCatalogSchema = z.object({
  generatedAt: z.string(),
  models: z.array(CatalogModelSchema),
  protocols: z.array(
    z.object({
      id: ProtocolIdSchema,
      label: z.string(),
      endpointPath: z.string(),
      models: z.array(z.string()),
    })
  ),
  notes: z.string().nullable(),
});
