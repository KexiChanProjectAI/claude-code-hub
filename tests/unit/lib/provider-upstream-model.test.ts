import { describe, expect, test } from "vitest";
import { resolveUpstreamModel } from "@/lib/provider-upstream-model";
import type { ProviderModelRedirectRule } from "@/types/provider";

function provider(
  providerPrefix: string | null,
  modelRedirects: ProviderModelRedirectRule[] | null = null
) {
  return { providerPrefix, modelRedirects };
}

describe("resolveUpstreamModel", () => {
  test("returns the model unchanged without prefix or rules", () => {
    expect(resolveUpstreamModel(provider(null), "gpt-5")).toEqual({
      model: "gpt-5",
      strippedModel: "gpt-5",
      prefixStripped: false,
      matchedRule: null,
    });
  });

  test("treats a missing providerPrefix field as no prefix", () => {
    expect(resolveUpstreamModel({ modelRedirects: null }, "openai/gpt-5").model).toBe(
      "openai/gpt-5"
    );
  });

  test("strips the prefix when there are no rules", () => {
    expect(resolveUpstreamModel(provider("openai/"), "openai/gpt-5.6-luna")).toEqual({
      model: "gpt-5.6-luna",
      strippedModel: "gpt-5.6-luna",
      prefixStripped: true,
      matchedRule: null,
    });
  });

  test("applies redirect rules written against the bare model name", () => {
    const rule: ProviderModelRedirectRule = {
      matchType: "exact",
      source: "gpt-5.6-luna",
      target: "luna-upstream",
    };
    const result = resolveUpstreamModel(provider("openai/", [rule]), "openai/gpt-5.6-luna");
    expect(result.model).toBe("luna-upstream");
    expect(result.strippedModel).toBe("gpt-5.6-luna");
    expect(result.prefixStripped).toBe(true);
    expect(result.matchedRule).toEqual(rule);
  });

  test("does not match redirect rules keyed on the prefixed name", () => {
    const result = resolveUpstreamModel(
      provider("openai/", [{ matchType: "exact", source: "openai/gpt-5.6-luna", target: "never" }]),
      "openai/gpt-5.6-luna"
    );
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.matchedRule).toBeNull();
  });

  test("expands regex capture groups against the stripped name", () => {
    const result = resolveUpstreamModel(
      provider("openai/", [{ matchType: "regex", source: "^gpt-(.+)$", target: "azure-gpt-$1" }]),
      "openai/gpt-5"
    );
    expect(result.model).toBe("azure-gpt-5");
  });

  test("leaves a non-matching model untouched but still applies rules", () => {
    const result = resolveUpstreamModel(
      provider("openai/", [{ matchType: "exact", source: "gpt-5", target: "gpt-5-upstream" }]),
      "gpt-5"
    );
    expect(result.prefixStripped).toBe(false);
    expect(result.strippedModel).toBe("gpt-5");
    expect(result.model).toBe("gpt-5-upstream");
  });
});
