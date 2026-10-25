import { describe, expect, test } from "vitest";
import {
  applyOpenAIChatProviderOverridesWithAudit,
  type OpenAIChatProviderOverrideContext,
} from "@/lib/openai/provider-overrides";

const provider = { id: 7, name: "oai", providerType: "openai-compatible" };

function context(
  overrides: Partial<OpenAIChatProviderOverrideContext> = {}
): OpenAIChatProviderOverrideContext {
  return {
    requestPath: "/v1/chat/completions",
    originalModel: "gpt-5.2",
    executionModel: "gpt-5.2",
    originalReasoningEffort: null,
    reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "high" }],
    ...overrides,
  };
}

describe("applyOpenAIChatProviderOverridesWithAudit", () => {
  test.each(["codex", "claude", "gemini"])("ignores %s providers", (providerType) => {
    const request = { model: "gpt-5.2", reasoning_effort: "low" };
    const result = applyOpenAIChatProviderOverridesWithAudit(
      { ...provider, providerType },
      request,
      context()
    );
    expect(result.request).toBe(request);
    expect(result.audit).toBeNull();
  });

  test.each(["/v1/responses", "/v1/embeddings", "/v1/chat/completions/abc"])(
    "ignores non Chat Completions path %s",
    (requestPath) => {
      const request = { model: "gpt-5.2" };
      const result = applyOpenAIChatProviderOverridesWithAudit(
        provider,
        request,
        context({ requestPath })
      );
      expect(result.request).toBe(request);
      expect(result.audit).toBeNull();
    }
  );

  test.each([[null], [[]]])("keeps the request untouched when rules are %j", (rules) => {
    const request = { model: "gpt-5.2", reasoning_effort: "low" };
    const result = applyOpenAIChatProviderOverridesWithAudit(
      provider,
      request,
      context({ reasoningEffortOverrideRules: rules })
    );
    expect(result.request).toBe(request);
    expect(result.audit).toBeNull();
  });

  test("injects reasoning_effort when the client sent none, without mutating the input", () => {
    const request = { model: "gpt-5.2", messages: [] };
    const result = applyOpenAIChatProviderOverridesWithAudit(provider, request, context());

    expect(request).toEqual({ model: "gpt-5.2", messages: [] });
    expect(result.request).toEqual({ model: "gpt-5.2", messages: [], reasoning_effort: "high" });
    expect(result.audit).toEqual({
      type: "provider_parameter_override",
      scope: "provider",
      providerId: 7,
      providerName: "oai",
      providerType: "openai-compatible",
      hit: true,
      changed: true,
      changes: [{ path: "reasoning_effort", before: null, after: "high", changed: true }],
      ruleEvaluation: { shouldOverride: true, overriddenEffort: "high", matchedIndex: 0 },
    });
  });

  test("reports an unchanged hit when the client already sent the target value", () => {
    const result = applyOpenAIChatProviderOverridesWithAudit(
      provider,
      { model: "gpt-5.2", reasoning_effort: "high" },
      context({ originalReasoningEffort: "high" })
    );
    expect(result.request.reasoning_effort).toBe("high");
    expect(result.audit?.changed).toBe(false);
    expect(result.audit?.changes[0]).toEqual({
      path: "reasoning_effort",
      before: "high",
      after: "high",
      changed: false,
    });
  });

  test("uses the first matching rule by model and original effort", () => {
    const rules = [
      { when: { originalModel: { matchType: "prefix", pattern: "o3" } }, overrideEffort: "low" },
      { when: { originalReasoningEffort: "medium" }, overrideEffort: "none" },
      { when: {}, overrideEffort: "xhigh" },
    ] as OpenAIChatProviderOverrideContext["reasoningEffortOverrideRules"];

    const matchedByEffort = applyOpenAIChatProviderOverridesWithAudit(
      provider,
      { model: "gpt-5.2", reasoning_effort: "medium" },
      context({ originalReasoningEffort: "medium", reasoningEffortOverrideRules: rules })
    );
    expect(matchedByEffort.request.reasoning_effort).toBe("none");
    expect(matchedByEffort.audit?.ruleEvaluation).toMatchObject({ matchedIndex: 1 });

    const matchedByModel = applyOpenAIChatProviderOverridesWithAudit(
      provider,
      { model: "o3-mini" },
      context({ originalModel: "o3-mini", reasoningEffortOverrideRules: rules })
    );
    expect(matchedByModel.request.reasoning_effort).toBe("low");
  });

  test("returns no audit when no rule matches", () => {
    const request = { model: "gpt-5.2", reasoning_effort: "low" };
    const result = applyOpenAIChatProviderOverridesWithAudit(
      provider,
      request,
      context({
        originalReasoningEffort: "low",
        reasoningEffortOverrideRules: [
          { when: { originalReasoningEffort: null }, overrideEffort: "high" },
        ],
      })
    );
    expect(result.request).toBe(request);
    expect(result.audit).toBeNull();
  });
});
