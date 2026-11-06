import { describe, expect, it } from "vitest";
import builtin from "@/lib/codex-catalog/data/codex-builtin-models.json";
import deepseek from "@/lib/codex-catalog/data/deepseek-models.json";
import {
  CodexCatalogModelSchema,
  CodexCatalogResponseSchema,
  describeCodexCatalogIssue,
} from "@/lib/codex-catalog/schema";
import { makeTemplate, REQUIRED_FIELDS } from "./fixtures";

describe("Codex catalog schema", () => {
  it("accepts the bundled Codex built-in catalog", () => {
    const parsed = CodexCatalogResponseSchema.safeParse(builtin);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.models.length).toBe(12);
  });

  it("accepts the bundled DeepSeek catalog", () => {
    const parsed = CodexCatalogResponseSchema.safeParse(deepseek);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.models.map((m) => m.slug)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("keeps unknown fields untouched", () => {
    const parsed = CodexCatalogModelSchema.parse({
      ...makeTemplate(),
      context_window: 272000,
      model_messages: { instructions_template: "x", tools: { a: 1 } },
    });
    expect(parsed.context_window).toBe(272000);
    expect(parsed.model_messages).toEqual({ instructions_template: "x", tools: { a: 1 } });
  });

  it.each(REQUIRED_FIELDS)("rejects an entry without %s", (field) => {
    const entry: Record<string, unknown> = { ...makeTemplate() };
    delete entry[field];
    expect(CodexCatalogModelSchema.safeParse(entry).success).toBe(false);
  });

  it("requires instructions_template or base_instructions", () => {
    const withoutBoth = { ...makeTemplate(), model_messages: undefined };
    const result = CodexCatalogModelSchema.safeParse(withoutBoth);
    expect(result.success).toBe(false);
    expect(describeCodexCatalogIssue(result.error!)).toContain("instructions_template");

    expect(
      CodexCatalogModelSchema.safeParse({ ...withoutBoth, base_instructions: "Be helpful." })
        .success
    ).toBe(true);
    expect(
      CodexCatalogModelSchema.safeParse({ ...makeTemplate(), model_messages: {} }).success
    ).toBe(false);
  });

  it.each([
    ["shell_type", "bash"],
    ["visibility", "LIST"],
    ["truncation_policy", { mode: "lines", limit: 1 }],
    ["priority", 1.5],
    ["slug", ""],
  ])("rejects invalid %s", (field, value) => {
    expect(CodexCatalogModelSchema.safeParse({ ...makeTemplate(), [field]: value }).success).toBe(
      false
    );
  });

  it("accepts every documented shell_type alias", () => {
    for (const shell of ["unified_exec", "disabled", "default", "local", "shell_command"]) {
      expect(
        CodexCatalogModelSchema.safeParse({ ...makeTemplate(), shell_type: shell }).success
      ).toBe(true);
    }
  });

  it("rejects the OpenAI list shape", () => {
    expect(CodexCatalogResponseSchema.safeParse({ object: "list", data: [] }).success).toBe(false);
  });

  it("describes an issue with a root path", () => {
    const result = CodexCatalogModelSchema.safeParse("nope");
    expect(describeCodexCatalogIssue(result.error!)).toMatch(/^\(root\): /);
  });
});
