import { describe, expect, test } from "vitest";
import {
  applyProviderPrefix,
  matchesProviderPrefix,
  normalizeProviderPrefix,
  PROVIDER_PREFIX_MAX_LENGTH,
  stripProviderPrefix,
} from "@/lib/provider-prefix";

describe("normalizeProviderPrefix", () => {
  test.each([
    ["openai", "openai/"],
    ["openai/", "openai/"],
    ["openai//", "openai/"],
    ["openai///", "openai/"],
    [" openai / ", "openai/"],
    ["  openai  ", "openai/"],
    ["OpenAI", "OpenAI/"],
    ["org/team", "org/team/"],
    ["org/team//", "org/team/"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeProviderPrefix(input)).toBe(expected);
  });

  test.each([[""], ["   "], ["/"], ["///"], [" / "]])("treats %j as no prefix", (input) => {
    expect(normalizeProviderPrefix(input)).toBeNull();
  });

  test("treats null and undefined as no prefix", () => {
    expect(normalizeProviderPrefix(null)).toBeNull();
    expect(normalizeProviderPrefix(undefined)).toBeNull();
  });

  test("keeps leading slashes untouched", () => {
    expect(normalizeProviderPrefix("/openai")).toBe("/openai/");
  });

  test("exposes the storage length limit", () => {
    expect(PROVIDER_PREFIX_MAX_LENGTH).toBe(64);
  });
});

describe("matchesProviderPrefix", () => {
  test("no prefix always matches", () => {
    expect(matchesProviderPrefix("gpt-5", null)).toBe(true);
    expect(matchesProviderPrefix("gpt-5", undefined)).toBe(true);
    expect(matchesProviderPrefix("gpt-5", "")).toBe(true);
  });

  test("matches models that start with the prefix", () => {
    expect(matchesProviderPrefix("openai/gpt-5.6-luna", "openai/")).toBe(true);
  });

  test("rejects models without the prefix", () => {
    expect(matchesProviderPrefix("gpt-5.6-luna", "openai/")).toBe(false);
    expect(matchesProviderPrefix("openaigpt-5", "openai/")).toBe(false);
    expect(matchesProviderPrefix("azure/openai/gpt-5", "openai/")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(matchesProviderPrefix("OpenAI/gpt-5", "openai/")).toBe(true);
    expect(matchesProviderPrefix("openai/gpt-5", "OPENAI/")).toBe(true);
  });

  test("rejects a model equal to the prefix (empty remainder)", () => {
    expect(matchesProviderPrefix("openai/", "openai/")).toBe(false);
  });
});

describe("stripProviderPrefix", () => {
  test("strips the prefix and keeps the remainder case", () => {
    expect(stripProviderPrefix("OpenAI/GPT-5.6-Luna", "openai/")).toBe("GPT-5.6-Luna");
  });

  test("strips only the configured prefix once", () => {
    expect(stripProviderPrefix("openai/openai/gpt-4", "openai/")).toBe("openai/gpt-4");
  });

  test("leaves non-matching models unchanged", () => {
    expect(stripProviderPrefix("gpt-5", "openai/")).toBe("gpt-5");
    expect(stripProviderPrefix("openai/", "openai/")).toBe("openai/");
  });

  test("leaves models unchanged without a prefix", () => {
    expect(stripProviderPrefix("openai/gpt-5", null)).toBe("openai/gpt-5");
  });
});

describe("applyProviderPrefix", () => {
  test("prepends the prefix", () => {
    expect(applyProviderPrefix("gpt-5", "openai/")).toBe("openai/gpt-5");
  });

  test("always prepends so listed IDs round-trip through strip", () => {
    const listed = applyProviderPrefix("openai/gpt-4", "openai/");
    expect(listed).toBe("openai/openai/gpt-4");
    expect(stripProviderPrefix(listed, "openai/")).toBe("openai/gpt-4");
  });

  test("returns the model unchanged without a prefix", () => {
    expect(applyProviderPrefix("gpt-5", null)).toBe("gpt-5");
    expect(applyProviderPrefix("gpt-5", "")).toBe("gpt-5");
  });
});
