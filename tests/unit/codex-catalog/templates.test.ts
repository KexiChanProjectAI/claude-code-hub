import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { logger } from "@/lib/logger";
import {
  deriveBareSlug,
  findTemplateForSlug,
  findVendorFamilyTemplate,
  loadBuiltinTemplates,
  mergeTemplates,
  modelFamily,
  parseTemplates,
  pickFallbackTemplate,
  resetBuiltinTemplatesForTests,
  VENDOR_TEMPLATE_PRIORITY_OFFSET,
} from "@/lib/codex-catalog/templates";
import { makeTemplate } from "./fixtures";

const templates = [
  makeTemplate({ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", priority: 1 }),
  makeTemplate({ slug: "gpt-6-sol", display_name: "GPT-6 Sol", priority: 3 }),
  makeTemplate({ slug: "gpt-6", display_name: "GPT-6", priority: 4 }),
  makeTemplate({ slug: "codex-auto-review", visibility: "hide", priority: 0 }),
];

describe("deriveBareSlug", () => {
  it("strips a matching provider prefix", () => {
    expect(deriveBareSlug("openai/gpt-6.1-sol", ["openai/"])).toBe("gpt-6.1-sol");
    expect(deriveBareSlug("OpenAI/gpt-6.1-sol", ["openai/"])).toBe("gpt-6.1-sol");
  });

  it("takes the last segment of a nested namespace", () => {
    expect(deriveBareSlug("openai/test/gpt-6.1-sol", ["openai/"])).toBe("gpt-6.1-sol");
    expect(deriveBareSlug("openai/test/gpt-6.1-sol", [])).toBe("gpt-6.1-sol");
  });

  it("returns plain ids unchanged", () => {
    expect(deriveBareSlug("gpt-6.1-sol", ["openai/"])).toBe("gpt-6.1-sol");
  });
});

describe("findTemplateForSlug", () => {
  it("prefers an exact (case-insensitive) match", () => {
    expect(findTemplateForSlug("GPT-6-SOL", templates)).toMatchObject({
      match: "exact",
      template: { slug: "gpt-6-sol" },
    });
  });

  it("uses the longest boundary-aware prefix", () => {
    expect(findTemplateForSlug("gpt-6.1-sol-fast", templates)).toMatchObject({
      match: "prefix",
      template: { slug: "gpt-6.1-sol" },
    });
    expect(findTemplateForSlug("gpt-6-sol-2026", templates)?.template.slug).toBe("gpt-6-sol");
    expect(findTemplateForSlug("gpt-6.1-sol:beta", templates)?.template.slug).toBe("gpt-6.1-sol");
  });

  it("does not match across a word boundary", () => {
    expect(findTemplateForSlug("gpt-6-solaris", templates)).toMatchObject({
      match: "prefix",
      template: { slug: "gpt-6" },
    });
    expect(findTemplateForSlug("gpt-60", templates)).toMatchObject({
      match: "family",
      template: { slug: "gpt-6.1-sol" },
    });
  });

  it("falls back to the first listed template", () => {
    expect(findTemplateForSlug("claude-sonnet-5", templates)).toMatchObject({
      match: "fallback",
      template: { slug: "gpt-6.1-sol" },
    });
  });

  it("returns null without templates", () => {
    expect(findTemplateForSlug("x", [])).toBeNull();
  });

  it("maps the whole DeepSeek series to DeepSeek templates", () => {
    const withVendor = [
      ...templates,
      makeTemplate({
        slug: "deepseek-flash",
        priority: 101,
        input_modalities: ["text", "image"],
      } as never),
      makeTemplate({ slug: "deepseek-v4-pro", priority: 102, input_modalities: ["text"] } as never),
    ];
    for (const [slug, expected] of [
      ["deepseek-v4-flash", "deepseek-flash"],
      ["deepseek-v4-flash-vision-exp", "deepseek-flash"],
      ["DeepSeek-VL2", "deepseek-flash"],
      ["deepseek-chat", "deepseek-v4-pro"],
      ["deepseek-reasoner", "deepseek-v4-pro"],
      ["DeepSeek-V3.2", "deepseek-v4-pro"],
      ["deepseek-r1", "deepseek-v4-pro"],
      ["deepseek-coder-v2", "deepseek-v4-pro"],
      ["deepseek_v3", "deepseek-v4-pro"],
      ["deepseek", "deepseek-v4-pro"],
    ] as const) {
      expect(findTemplateForSlug(slug, withVendor), slug).toMatchObject({
        match: "vendor",
        template: { slug: expected },
      });
    }
    expect(findTemplateForSlug("deepseeker-1", withVendor)?.match).toBe("fallback");
    expect(findTemplateForSlug("deepseek-v4-pro-0601", withVendor)).toMatchObject({
      match: "prefix",
      template: { slug: "deepseek-v4-pro" },
    });
  });

  it("skips families that only have hidden templates", () => {
    expect(findTemplateForSlug("codex-mini", templates)).toMatchObject({
      match: "fallback",
      template: { slug: "gpt-6.1-sol" },
    });
  });
});

describe("modelFamily", () => {
  it("returns the first dash segment", () => {
    expect(modelFamily("DeepSeek-V4-Flash")).toBe("deepseek");
    expect(modelFamily("o3")).toBeNull();
    expect(modelFamily("-x")).toBeNull();
  });
});

describe("findVendorFamilyTemplate", () => {
  it("skips a vendor whose templates are missing", () => {
    expect(findVendorFamilyTemplate("deepseek-chat", templates)).toBeNull();
  });
});

describe("mergeTemplates", () => {
  it("appends vendor templates behind the built-ins and lets built-ins win", () => {
    const merged = mergeTemplates(
      [makeTemplate({ slug: "gpt-6.1-sol", priority: 1 })],
      [
        [
          makeTemplate({ slug: "deepseek-flash", priority: 1 }),
          makeTemplate({ slug: "GPT-6.1-SOL", display_name: "vendor copy", priority: 5 }),
        ],
      ]
    );
    expect(merged.map((t) => [t.slug, t.priority])).toEqual([
      ["gpt-6.1-sol", 1],
      ["deepseek-flash", 1 + VENDOR_TEMPLATE_PRIORITY_OFFSET],
    ]);
  });
});

describe("pickFallbackTemplate", () => {
  it("skips hidden templates", () => {
    expect(pickFallbackTemplate(templates)?.slug).toBe("gpt-6.1-sol");
  });

  it("uses the first template when none is listed", () => {
    const hidden = [makeTemplate({ slug: "a", visibility: "hide" })];
    expect(pickFallbackTemplate(hidden)?.slug).toBe("a");
    expect(pickFallbackTemplate([])).toBeNull();
  });
});

describe("parseTemplates / loadBuiltinTemplates", () => {
  beforeEach(() => resetBuiltinTemplatesForTests());

  it("drops invalid and duplicate entries", () => {
    const parsed = parseTemplates({
      models: [
        makeTemplate({ slug: "a" }),
        { ...makeTemplate({ slug: "b" }), shell_type: "bash" },
        makeTemplate({ slug: "a", display_name: "dup" }),
        null,
      ],
    });
    expect(parsed.map((t) => t.slug)).toEqual(["a"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns an empty list for malformed input", () => {
    expect(parseTemplates(null)).toEqual([]);
    expect(parseTemplates({ models: "x" })).toEqual([]);
  });

  it("loads and memoizes the bundled templates", () => {
    const first = loadBuiltinTemplates();
    expect(first.length).toBe(14);
    expect(pickFallbackTemplate(first)?.slug).toBe("gpt-6.1-sol");
    expect(loadBuiltinTemplates()).toBe(first);
    const sol = first.find((t) => t.slug === "gpt-6.1-sol");
    expect(sol?.model_messages?.instructions_template?.length).toBeGreaterThan(10_000);
  });

  it("bundles DeepSeek's own Codex entries", () => {
    const templates = loadBuiltinTemplates();
    const flash = templates.find((t) => t.slug === "deepseek-flash");
    const pro = templates.find((t) => t.slug === "deepseek-v4-pro");
    expect(flash).toMatchObject({
      display_name: "DeepSeek-Flash",
      priority: 1 + VENDOR_TEMPLATE_PRIORITY_OFFSET,
      prefer_websockets: false,
      use_responses_lite: false,
      tool_mode: null,
      context_window: 1048576,
      input_modalities: ["text", "image"],
      experimental_supported_tools: [],
    });
    expect(flash?.supported_reasoning_levels.map((l) => l.effort)).toEqual(["low", "high", "max"]);
    expect(pro).toMatchObject({ input_modalities: ["text"], supports_search_tool: false });
    expect(flash?.model_messages?.instructions_template?.length).toBeGreaterThan(10_000);
    const maxBuiltin = Math.max(
      ...templates.filter((t) => !t.slug.startsWith("deepseek")).map((t) => t.priority)
    );
    expect(flash!.priority).toBeGreaterThan(maxBuiltin);
  });
});
