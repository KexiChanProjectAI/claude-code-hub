import { z } from "zod";

/**
 * Codex CLI model catalog contract (`codex_protocol::openai_models::ModelInfo`).
 *
 * Only the fields Codex requires are validated. Any other field is passed through
 * untouched (`looseObject`), because Codex ignores unknown fields and the bundled
 * templates carry many optional ones (`model_messages.tools`, `service_tiers`, ...).
 * A single invalid entry makes Codex reject the WHOLE catalog, so every entry is
 * validated on the gateway side before it is served.
 */

export const CODEX_SHELL_TYPES = [
  "unified_exec",
  "disabled",
  "default",
  "local",
  "shell_command",
] as const;

export const CODEX_VISIBILITIES = ["list", "hide", "none"] as const;

export const CodexReasoningLevelSchema = z.looseObject({
  effort: z.string().min(1),
  description: z.string(),
});

export const CodexTruncationPolicySchema = z.looseObject({
  mode: z.enum(["tokens", "bytes"]),
  limit: z.number().int(),
});

export const CodexCatalogModelSchema = z
  .looseObject({
    slug: z.string().min(1),
    display_name: z.string().min(1),
    supported_reasoning_levels: z.array(CodexReasoningLevelSchema),
    shell_type: z.enum(CODEX_SHELL_TYPES),
    visibility: z.enum(CODEX_VISIBILITIES),
    supported_in_api: z.boolean(),
    priority: z.number().int(),
    support_verbosity: z.boolean(),
    truncation_policy: CodexTruncationPolicySchema,
    experimental_supported_tools: z.array(z.string()),
    model_messages: z
      .looseObject({ instructions_template: z.string().optional().nullable() })
      .optional()
      .nullable(),
    base_instructions: z.string().optional().nullable(),
  })
  .refine(
    (model) =>
      Boolean(model.model_messages?.instructions_template) || Boolean(model.base_instructions),
    {
      message: "missing both base_instructions and model_messages.instructions_template",
      path: ["model_messages", "instructions_template"],
    }
  );

export const CodexCatalogResponseSchema = z.looseObject({
  models: z.array(CodexCatalogModelSchema),
});

export type CodexCatalogModel = z.infer<typeof CodexCatalogModelSchema>;
export type CodexCatalogResponse = z.infer<typeof CodexCatalogResponseSchema>;

/** Format the first zod issue as a short single-line reason for logs. */
export function describeCodexCatalogIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid entry";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
