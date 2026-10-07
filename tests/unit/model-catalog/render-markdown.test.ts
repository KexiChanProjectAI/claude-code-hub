import { describe, expect, it } from "vitest";
import { renderCatalogMarkdown } from "@/lib/model-catalog/render-markdown";
import type { CatalogModel, ModelCatalog } from "@/lib/model-catalog/types";

function model(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    vendor: "anthropic",
    vendorName: "Anthropic",
    vendorIcon: null,
    vendorIconMono: false,
    protocols: ["claude"],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: {
      vision: true,
      functionCalling: true,
      reasoning: false,
      pdfInput: false,
      promptCaching: true,
    },
    modalities: { input: ["text", "image"], output: ["text"] },
    knowledgeCutoff: "2025-03",
    deprecated: false,
    hasPriceData: true,
    ...overrides,
  };
}

function catalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    generatedAt: "2026-10-07T00:00:00.000Z",
    models: [
      model({}),
      model({
        id: "weird|model",
        displayName: "weird|model",
        vendor: null,
        vendorName: null,
        protocols: ["claude", "openai"],
        contextWindow: null,
        maxOutputTokens: 1500,
        pricing: null,
        capabilities: null,
        modalities: null,
        knowledgeCutoff: null,
        deprecated: true,
        hasPriceData: false,
      }),
    ],
    protocols: [
      {
        id: "claude",
        label: "Anthropic Messages API",
        endpointPath: "/v1/messages",
        models: ["claude-sonnet-4-5", "weird|model"],
      },
      {
        id: "openai",
        label: "OpenAI Chat Completions API",
        endpointPath: "/v1/chat/completions",
        models: ["weird|model"],
      },
      {
        id: "gemini",
        label: "Gemini API",
        endpointPath: "/v1beta/models/{model}:generateContent",
        models: [],
      },
    ],
    notes: "## Rules\n- Prefer Sonnet for coding",
    ...overrides,
  };
}

describe("renderCatalogMarkdown", () => {
  it("renders header, tables, per-protocol lists and notes", () => {
    const md = renderCatalogMarkdown(catalog(), { baseUrl: "https://hub.example.com/" });

    expect(md.startsWith("# Model Catalog\n")).toBe(true);
    expect(md).toContain("Generated at: 2026-10-07T00:00:00.000Z");
    expect(md).toContain("Base URL: https://hub.example.com (append");
    expect(md).toContain("| claude | Anthropic Messages API | `/v1/messages` | 2 |");
    expect(md).toContain("| gemini | Gemini API | `/v1beta/models/{model}:generateContent` | 0 |");
    expect(md).toContain(
      "| `claude-sonnet-4-5` (Claude Sonnet 4.5) | Anthropic | claude | 200K | 64K | $3 | $15 | $0.3 | $3.75 | vision, tools, prompt-caching | text+image -> text | 2025-03 | no |"
    );
    expect(md).toContain(
      "| `weird\\|model` | n/a | claude, openai | n/a | 1500 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | yes |"
    );
    expect(md).toContain("### claude: Anthropic Messages API (`/v1/messages`)");
    expect(md).toContain("### openai: OpenAI Chat Completions API (`/v1/chat/completions`)");
    expect(md).not.toContain("### gemini");
    expect(md).toContain("- JSON: `GET https://hub.example.com/v1/models/catalog`");
    expect(md).toContain("- Markdown: `GET https://hub.example.com/v1/models/catalog?format=md`");
    expect(md.trimEnd().endsWith("## Rules\n- Prefer Sonnet for coding")).toBe(true);
    expect(md).toContain("## Notes from the administrator");
  });

  it("omits notes and per-protocol sections for an empty catalog", () => {
    const md = renderCatalogMarkdown(
      catalog({
        models: [],
        notes: null,
        protocols: [{ id: "claude", label: "x", endpointPath: "/v1/messages", models: [] }],
      }),
      { baseUrl: null }
    );
    expect(md).toContain("No models are available to this key.");
    expect(md).toContain("Base URL: the origin this document was fetched from.");
    expect(md).toContain("- JSON: `GET /v1/models/catalog`");
    expect(md).not.toContain("## Models by protocol");
    expect(md).not.toContain("## Notes from the administrator");
  });

  it("formats capability-less models and million-token windows", () => {
    const md = renderCatalogMarkdown(
      catalog({
        models: [
          model({
            displayName: "claude-sonnet-4-5",
            contextWindow: 1_000_000,
            capabilities: {
              vision: false,
              functionCalling: false,
              reasoning: true,
              pdfInput: true,
              promptCaching: false,
            },
          }),
        ],
        notes: null,
      }),
      { baseUrl: null }
    );
    expect(md).toContain("| `claude-sonnet-4-5` | Anthropic | claude | 1M |");
    expect(md).toContain("| reasoning, pdf |");
    const none = renderCatalogMarkdown(
      catalog({
        models: [
          model({
            capabilities: {
              vision: false,
              functionCalling: false,
              reasoning: false,
              pdfInput: false,
              promptCaching: false,
            },
          }),
        ],
      }),
      { baseUrl: null }
    );
    expect(none).toContain("| none |");
  });
});
