import { describe, expect, it } from "vitest";
import {
  buildProviderBatchApplyUpdates,
  hasLegacyServiceTierOverrideFields,
  hasProviderBatchPatchChanges,
  hasProviderServiceTierOverrideRulesField,
  normalizeProviderBatchPatchDraft,
  validateProviderServiceTierOverrideBatch,
  validateProviderServiceTierOverrideMutation,
} from "@/lib/provider-patch-contract";

describe("provider-patch-contract - codex service tier", () => {
  it("normalizes codex_service_tier_preference patch draft", () => {
    const result = normalizeProviderBatchPatchDraft({
      codex_service_tier_preference: { set: "priority" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.codex_service_tier_preference).toEqual({
      mode: "set",
      value: "priority",
    });
  });

  it("builds apply updates for codex_service_tier_preference", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      codex_service_tier_preference: { set: "priority" },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const updates = buildProviderBatchApplyUpdates(normalized.data);
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;

    expect(updates.data.codex_service_tier_preference).toBe("priority");
  });

  it("builds apply updates for codex_image_generation_preference", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      codex_image_generation_preference: { set: "false" },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const updates = buildProviderBatchApplyUpdates(normalized.data);
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;

    expect(updates.data.codex_image_generation_preference).toBe("false");
  });
});

describe("provider-patch-contract - service tier override rules", () => {
  const rules = [
    {
      when: { originalModel: { matchType: "prefix" as const, pattern: "gpt-5" } },
      overrideServiceTier: null,
    },
    { when: {}, overrideServiceTier: "priority" as const },
  ];

  it("normalizes set, clear and no_change drafts", () => {
    const set = normalizeProviderBatchPatchDraft({ service_tier_override_rules: { set: rules } });
    expect(set.ok && set.data.service_tier_override_rules).toEqual({ mode: "set", value: rules });

    const clear = normalizeProviderBatchPatchDraft({
      service_tier_override_rules: { clear: true },
    });
    expect(clear.ok && clear.data.service_tier_override_rules).toEqual({ mode: "clear" });

    const none = normalizeProviderBatchPatchDraft({});
    expect(none.ok && none.data.service_tier_override_rules).toEqual({ mode: "no_change" });
  });

  it.each([
    [[{ when: {}, overrideServiceTier: "" }]],
    [[{ when: {}, overrideServiceTier: "turbo" }]],
    [[{ when: { originalReasoningEffort: "high" }, overrideServiceTier: "flex" }]],
    ["not-a-list"],
  ])("rejects an invalid set value %j", (value) => {
    const result = normalizeProviderBatchPatchDraft({
      service_tier_override_rules: { set: value },
    });
    expect(result.ok).toBe(false);
  });

  it("builds apply updates for set and clear (clear writes null)", () => {
    const set = normalizeProviderBatchPatchDraft({ service_tier_override_rules: { set: rules } });
    if (!set.ok) throw new Error("expected ok");
    const setUpdates = buildProviderBatchApplyUpdates(set.data);
    expect(setUpdates.ok && setUpdates.data.service_tier_override_rules).toEqual(rules);
    expect(hasProviderBatchPatchChanges(set.data)).toBe(true);

    const clear = normalizeProviderBatchPatchDraft({
      service_tier_override_rules: { clear: true },
    });
    if (!clear.ok) throw new Error("expected ok");
    const clearUpdates = buildProviderBatchApplyUpdates(clear.data);
    expect(clearUpdates.ok).toBe(true);
    expect(clearUpdates.ok && clearUpdates.data.service_tier_override_rules).toBeNull();
  });
});

describe("provider-patch-contract - service tier override validation", () => {
  const base = {
    providerType: "codex" as const,
    hasRulesField: true,
    rules: [{ when: {}, overrideServiceTier: null }],
    hasLegacyFields: false,
    existingRules: null,
  };

  it("detects rules and legacy fields only when defined", () => {
    expect(hasProviderServiceTierOverrideRulesField({ service_tier_override_rules: [] })).toBe(
      true
    );
    expect(hasProviderServiceTierOverrideRulesField({ service_tier_override_rules: null })).toBe(
      true
    );
    expect(
      hasProviderServiceTierOverrideRulesField({ service_tier_override_rules: undefined })
    ).toBe(false);
    expect(hasLegacyServiceTierOverrideFields({ codex_service_tier_preference: "flex" })).toBe(
      true
    );
    expect(hasLegacyServiceTierOverrideFields({ codex_service_tier_preference: undefined })).toBe(
      false
    );
  });

  it("accepts codex rules with a null target", () => {
    expect(validateProviderServiceTierOverrideMutation(base)).toEqual({ ok: true });
  });

  it("rejects co-emission of rules and the legacy field", () => {
    const result = validateProviderServiceTierOverrideMutation({ ...base, hasLegacyFields: true });
    expect(result.ok).toBe(false);
  });

  it("rejects legacy-only writes when rules already exist", () => {
    const result = validateProviderServiceTierOverrideMutation({
      ...base,
      hasRulesField: false,
      rules: undefined,
      hasLegacyFields: true,
      existingRules: [{ when: {}, overrideServiceTier: "flex" }],
    });
    expect(result.ok).toBe(false);
  });

  it("allows legacy-only writes when no rules exist", () => {
    const result = validateProviderServiceTierOverrideMutation({
      ...base,
      hasRulesField: false,
      rules: undefined,
      hasLegacyFields: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects rules for non-codex providers", () => {
    const result = validateProviderServiceTierOverrideMutation({ ...base, providerType: "claude" });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid targets that bypass zod", () => {
    const result = validateProviderServiceTierOverrideMutation({
      ...base,
      rules: [{ when: {}, overrideServiceTier: "turbo" as never }],
    });
    expect(result).toEqual({ ok: false, error: "Invalid service tier override target: turbo" });
  });

  it("validates batch patches only against codex providers", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      service_tier_override_rules: { set: [{ when: {}, overrideServiceTier: "flex" }] },
    });
    if (!normalized.ok) throw new Error("expected ok");

    expect(
      validateProviderServiceTierOverrideBatch({
        patch: normalized.data,
        providers: [
          { providerType: "claude", serviceTierOverrideRules: null },
          { providerType: "codex", serviceTierOverrideRules: null },
        ],
      })
    ).toEqual({ ok: true });
  });

  it("rejects batch legacy patches for codex providers that already have rules", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      codex_service_tier_preference: { set: "priority" },
    });
    if (!normalized.ok) throw new Error("expected ok");

    const result = validateProviderServiceTierOverrideBatch({
      patch: normalized.data,
      providers: [
        {
          providerType: "codex",
          serviceTierOverrideRules: [{ when: {}, overrideServiceTier: null }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
