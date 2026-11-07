import { describe, expect, it } from "vitest";
import {
  applyDisplayNameSuffix,
  DISPLAY_NAME_SUFFIX_MAX_LENGTH,
  normalizeDisplayNameSuffix,
} from "@/lib/display-name-suffix";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";

describe("normalizeDisplayNameSuffix", () => {
  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["   ", null],
    ["()", null],
    ["cyber", "cyber"],
    ["  cyber  ", "cyber"],
    ["(cyber)", "cyber"],
    [" ( cyber team ) ", "cyber team"],
    ["cyber   team", "cyber team"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeDisplayNameSuffix(input as string | null | undefined)).toBe(expected);
  });
});

describe("applyDisplayNameSuffix", () => {
  it("appends the normalized suffix in parentheses", () => {
    expect(applyDisplayNameSuffix("gpt-6-sol", "cyber")).toBe("gpt-6-sol (cyber)");
    expect(applyDisplayNameSuffix("gpt-6-sol", "(cyber)")).toBe("gpt-6-sol (cyber)");
  });

  it("leaves the name alone without a suffix", () => {
    expect(applyDisplayNameSuffix("gpt-6-sol", null)).toBe("gpt-6-sol");
    expect(applyDisplayNameSuffix("gpt-6-sol", " ")).toBe("gpt-6-sol");
  });
});

describe("provider schemas", () => {
  const base = { name: "p", url: "https://example.com", key: "sk-1234567890" };

  it("normalizes display_name_suffix on create and update", () => {
    const created = CreateProviderSchema.parse({ ...base, display_name_suffix: " (cyber) " });
    expect(created.display_name_suffix).toBe("cyber");
    expect(UpdateProviderSchema.parse({ display_name_suffix: "" }).display_name_suffix).toBeNull();
    expect(
      UpdateProviderSchema.parse({ display_name_suffix: null }).display_name_suffix
    ).toBeNull();
    expect(UpdateProviderSchema.parse({ name: "renamed" }).display_name_suffix).toBeUndefined();
  });

  it("rejects suffixes longer than the column", () => {
    const tooLong = "x".repeat(DISPLAY_NAME_SUFFIX_MAX_LENGTH + 1);
    expect(UpdateProviderSchema.safeParse({ display_name_suffix: tooLong }).success).toBe(false);
    expect(
      UpdateProviderSchema.safeParse({
        display_name_suffix: "x".repeat(DISPLAY_NAME_SUFFIX_MAX_LENGTH),
      }).success
    ).toBe(true);
  });
});
