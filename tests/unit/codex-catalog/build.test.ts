import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import {
  buildCodexCatalogEntry,
  buildCodexCatalogModels,
  serializeCodexCatalog,
} from "@/lib/codex-catalog/build";
import { CodexCatalogResponseSchema } from "@/lib/codex-catalog/schema";
import { loadBuiltinTemplates } from "@/lib/codex-catalog/templates";
import { logger } from "@/lib/logger";
import { makeTemplate } from "./fixtures";

const templates = [
  makeTemplate({
    slug: "gpt-6.1-sol",
    display_name: "GPT-6.1 Sol",
    priority: 1,
    supported_in_api: false,
    context_window: 272000,
  } as never),
  makeTemplate({ slug: "gpt-6-luna", display_name: "GPT-6 Luna", priority: 4 }),
  makeTemplate({ slug: "codex-auto-review", visibility: "hide", priority: 43 }),
];

describe("buildCodexCatalogEntry", () => {
  it("keeps template metadata and replaces identity fields", () => {
    const entry = buildCodexCatalogEntry("openai/gpt-6.1-sol", templates, ["openai/"]);
    expect(entry).toMatchObject({
      slug: "openai/gpt-6.1-sol",
      display_name: "GPT-6.1 Sol",
      priority: 1,
      supported_in_api: true,
      context_window: 272000,
      model_messages: { instructions_template: "You are Codex." },
    });
  });

  it("uses the gateway id as display name for non-exact matches", () => {
    expect(buildCodexCatalogEntry("gpt-6-luna-fast", templates, [])?.display_name).toBe(
      "gpt-6-luna-fast"
    );
    expect(buildCodexCatalogEntry("deepseek-v4", templates, [])).toMatchObject({
      slug: "deepseek-v4",
      display_name: "deepseek-v4",
      priority: 1000,
    });
  });

  it("keeps hidden visibility for exact hidden templates", () => {
    expect(buildCodexCatalogEntry("codex-auto-review", templates, [])?.visibility).toBe("hide");
  });

  it("does not mutate the template", () => {
    const entry = buildCodexCatalogEntry("gpt-6.1-sol", templates, []);
    (entry?.model_messages as { instructions_template: string }).instructions_template = "x";
    expect(templates[0].model_messages?.instructions_template).toBe("You are Codex.");
  });

  it("returns null without templates", () => {
    expect(buildCodexCatalogEntry("gpt-6.1-sol", [], [])).toBeNull();
  });
});

describe("buildCodexCatalogModels", () => {
  it("dedupes slugs and sorts by priority then slug", () => {
    const models = buildCodexCatalogModels(
      {
        gatewayIds: ["gpt-6-luna", "b/gpt-6.1-sol", "a/gpt-6.1-sol", "gpt-6-luna", ""],
        providerPrefixes: [],
      },
      templates
    );
    expect(models.map((m) => m.slug)).toEqual(["a/gpt-6.1-sol", "b/gpt-6.1-sol", "gpt-6-luna"]);
  });

  it("drops entries that fail validation instead of failing the catalog", () => {
    const broken = [makeTemplate({ slug: "gpt-x", shell_type: "bash" as never })];
    const models = buildCodexCatalogModels(
      { gatewayIds: ["gpt-x", "gpt-y"], providerPrefixes: [] },
      broken
    );
    expect(models).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[CodexCatalog] Dropping invalid catalog entry",
      expect.objectContaining({ slug: "gpt-x" })
    );
  });

  it("warns when no template exists", () => {
    expect(buildCodexCatalogModels({ gatewayIds: ["a"], providerPrefixes: [] }, [])).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("[CodexCatalog] No template available for model", {
      slug: "a",
    });
  });

  it("produces a catalog Codex can parse from the bundled templates", () => {
    const models = buildCodexCatalogModels(
      {
        gatewayIds: ["openai/test/gpt-6.1-sol", "gpt-5.5", "my-custom-model"],
        providerPrefixes: ["openai/"],
      },
      loadBuiltinTemplates()
    );
    const parsed = CodexCatalogResponseSchema.parse(JSON.parse(serializeCodexCatalog(models).body));
    expect(parsed.models.map((m) => m.slug)).toEqual([
      "openai/test/gpt-6.1-sol",
      "gpt-5.5",
      "my-custom-model",
    ]);
    expect(parsed.models[0].display_name).toBe("GPT-6.1-Sol");
    expect(parsed.models[2].priority).toBe(1000);
  });
});

describe("serializeCodexCatalog", () => {
  it("wraps models and derives a deterministic strong ETag", () => {
    const models = buildCodexCatalogModels(
      { gatewayIds: ["gpt-6.1-sol"], providerPrefixes: [] },
      templates
    );
    const a = serializeCodexCatalog(models);
    const b = serializeCodexCatalog(models);
    expect(JSON.parse(a.body).models).toHaveLength(1);
    expect(a.etag).toBe(b.etag);
    expect(a.etag).toMatch(/^"cch-codex-[0-9a-f]{32}"$/);
    expect(serializeCodexCatalog([]).etag).not.toBe(a.etag);
    expect(serializeCodexCatalog([]).body).toBe('{"models":[]}');
  });
});
