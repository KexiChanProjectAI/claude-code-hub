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

describe("DeepSeek models in the catalog", () => {
  it("get DeepSeek metadata and sort after the GPT models", () => {
    const models = buildCodexCatalogModels(
      {
        gatewayIds: ["deepseek/deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5"],
        providerPrefixes: ["deepseek/"],
      },
      loadBuiltinTemplates()
    );
    expect(models.map((m) => [m.slug, m.display_name, m.priority])).toEqual([
      ["gpt-5.5", "GPT-5.5", 13],
      ["deepseek/deepseek-flash", "DeepSeek-Flash", 101],
      ["deepseek-v4-pro", "DeepSeek-V4-Pro", 102],
      ["deepseek-v4-flash", "deepseek-v4-flash", 152],
    ]);
    const v4Flash = models[3];
    expect(v4Flash.prefer_websockets).toBe(false);
    expect(v4Flash.input_modalities).toEqual(["text"]);
    expect(v4Flash.context_window).toBe(1048576);
    expect(v4Flash.supported_reasoning_levels.map((l) => l.effort)).toEqual(["low", "high", "max"]);
  });

  it("give every DeepSeek series model metadata matching its real capabilities", () => {
    const models = buildCodexCatalogModels(
      {
        gatewayIds: [
          "openrouter/deepseek/deepseek-v4.1-flash",
          "openrouter/deepseek/deepseek-v4.1-flash-1017",
          "~deepseek/deepseek-flash-latest",
          "deepseek-flash-cyber",
          "deepseek-v4-flash-vision-exp",
          "deepseek-v4-flash-0731",
          "~deepseek/deepseek-pro-latest",
          "deepseek-v4-pro-0813",
          "deepseek-chat",
          "deepseek-reasoner",
          "deepseek-ai/DeepSeek-V3.2",
          "openrouter/deepseek/deepseek-r1-0528",
          "my-unknown-model",
        ],
        providerPrefixes: ["openrouter/"],
      },
      loadBuiltinTemplates()
    );
    const bySlug = Object.fromEntries(models.map((m) => [m.slug, m]));
    const image = ["text", "image"];
    const text = ["text"];
    const expectations: [string, string[], number, number][] = [
      ["openrouter/deepseek/deepseek-v4.1-flash", image, 1048576, 151],
      ["openrouter/deepseek/deepseek-v4.1-flash-1017", image, 1048576, 151],
      ["~deepseek/deepseek-flash-latest", image, 1048576, 101],
      ["deepseek-flash-cyber", image, 1048576, 101],
      ["deepseek-v4-flash-vision-exp", image, 1048576, 151],
      ["deepseek-v4-flash-0731", text, 1048576, 152],
      ["~deepseek/deepseek-pro-latest", text, 1048576, 152],
      ["deepseek-v4-pro-0813", text, 1048576, 102],
      ["deepseek-chat", text, 131072, 152],
      ["deepseek-reasoner", text, 131072, 152],
      ["deepseek-ai/DeepSeek-V3.2", text, 131072, 152],
      ["openrouter/deepseek/deepseek-r1-0528", text, 131072, 152],
    ];
    for (const [slug, modalities, contextWindow, priority] of expectations) {
      expect(bySlug[slug], slug).toMatchObject({
        input_modalities: modalities,
        context_window: contextWindow,
        max_context_window: contextWindow,
        priority,
        prefer_websockets: false,
        use_responses_lite: false,
        tool_mode: null,
      });
      expect(bySlug[slug].model_messages?.instructions_template?.length, slug).toBeGreaterThan(
        10_000
      );
    }
    for (const slug of ["deepseek-chat", "openrouter/deepseek/deepseek-r1-0528"]) {
      expect(bySlug[slug].supported_reasoning_levels).toEqual([]);
      expect(bySlug[slug].default_reasoning_level).toBeNull();
    }
    expect(bySlug["deepseek-v4-flash-0731"].supported_reasoning_levels).toHaveLength(3);
    expect(bySlug["my-unknown-model"].priority).toBe(1000);
    expect(models.at(-1)?.slug).toBe("my-unknown-model");
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
