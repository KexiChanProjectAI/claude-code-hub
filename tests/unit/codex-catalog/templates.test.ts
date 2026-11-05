import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { logger } from "@/lib/logger";
import {
  deriveBareSlug,
  findTemplateForSlug,
  loadBuiltinTemplates,
  parseTemplates,
  pickFallbackTemplate,
  resetBuiltinTemplatesForTests,
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
    expect(findTemplateForSlug("gpt-60", templates)?.match).toBe("fallback");
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
    expect(first.length).toBe(12);
    expect(loadBuiltinTemplates()).toBe(first);
    const sol = first.find((t) => t.slug === "gpt-6.1-sol");
    expect(sol?.model_messages?.instructions_template?.length).toBeGreaterThan(10_000);
  });
});
