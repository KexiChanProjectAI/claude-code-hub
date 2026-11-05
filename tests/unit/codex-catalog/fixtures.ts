import type { CodexCatalogModel } from "@/lib/codex-catalog/schema";

/** Minimal valid Codex catalog entry (mirrors the handoff "minimal" sample). */
export function makeTemplate(overrides: Partial<CodexCatalogModel> = {}): CodexCatalogModel {
  return {
    slug: "gpt-6.1-sol",
    display_name: "GPT-6.1 Sol",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    model_messages: { instructions_template: "You are Codex." },
    ...overrides,
  } as CodexCatalogModel;
}

export const REQUIRED_FIELDS = [
  "slug",
  "display_name",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "support_verbosity",
  "truncation_policy",
  "experimental_supported_tools",
] as const;
