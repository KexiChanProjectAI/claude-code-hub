import { describe, expect, it } from "vitest";
import {
  validateProviderReasoningEffortOverrideMutation,
  validateProviderServiceTierOverrideBatch,
  validateProviderServiceTierOverrideMutation,
} from "@/lib/provider-patch-contract";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";
import { ProviderCreateSchema, ProviderUpdateSchema } from "@/lib/api/v1/schemas/providers";

const serviceTierRules = [{ overrideServiceTier: "priority" }] as never;

describe("provider patch contract with multi-protocol rows", () => {
  it("allows service tier rules on a claude row that serves responses", () => {
    expect(
      validateProviderServiceTierOverrideMutation({
        providerType: "claude",
        protocols: ["claude", "response"],
        hasRulesField: true,
        rules: serviceTierRules,
        hasLegacyFields: false,
        existingRules: null,
      })
    ).toEqual({ ok: true });
    expect(
      validateProviderServiceTierOverrideMutation({
        providerType: "claude",
        protocols: ["claude", "openai"],
        hasRulesField: true,
        rules: serviceTierRules,
        hasLegacyFields: false,
        existingRules: null,
      }).ok
    ).toBe(false);
  });

  it("accepts reasoning effort targets valid for any served family", () => {
    const rules = [{ overrideEffort: "minimal" }] as never;
    expect(
      validateProviderReasoningEffortOverrideMutation({
        providerType: "claude",
        hasRulesField: true,
        rules,
        hasLegacyFields: false,
        existingRules: null,
      }).ok
    ).toBe(false);
    expect(
      validateProviderReasoningEffortOverrideMutation({
        providerType: "claude",
        protocols: ["claude", "openai"],
        hasRulesField: true,
        rules,
        hasLegacyFields: false,
        existingRules: null,
      })
    ).toEqual({ ok: true });
    expect(
      validateProviderReasoningEffortOverrideMutation({
        providerType: "gemini",
        hasRulesField: true,
        rules,
        hasLegacyFields: false,
        existingRules: null,
      }).ok
    ).toBe(false);
  });

  it("checks batch service tier rules on every row serving responses", () => {
    const patch = {
      service_tier_override_rules: { mode: "set", value: [{ overrideServiceTier: "bogus" }] },
      codex_service_tier_preference: { mode: "no_change" },
    } as never;
    expect(
      validateProviderServiceTierOverrideBatch({
        patch,
        providers: [{ providerType: "claude", serviceTierOverrideRules: null }],
      })
    ).toEqual({ ok: true });
    expect(
      validateProviderServiceTierOverrideBatch({
        patch,
        providers: [
          {
            providerType: "claude",
            protocols: ["claude", "response"],
            serviceTierOverrideRules: null,
          },
        ],
      }).ok
    ).toBe(false);
  });
});

describe("provider schemas accept and validate protocols", () => {
  const base = { name: "p", url: "https://up.example.com/v1", key: "k" };

  it("parses protocols and protocol_urls in the action schemas", () => {
    const created = CreateProviderSchema.parse({
      ...base,
      provider_type: "claude",
      protocols: ["claude", "openai"],
      protocol_urls: { openai: "https://o.example.com" },
    });
    expect(created.protocols).toEqual(["claude", "openai"]);
    expect(
      CreateProviderSchema.safeParse({ ...base, provider_type: "gemini", protocols: ["claude"] })
        .success
    ).toBe(false);
    expect(UpdateProviderSchema.safeParse({ protocol_urls: { openai: "nope" } }).success).toBe(
      false
    );
  });

  it("parses protocols in the REST schemas", () => {
    expect(
      ProviderCreateSchema.safeParse({
        ...base,
        provider_type: "codex",
        protocols: ["response", "claude"],
        protocol_urls: { claude: "https://a.example.com/anthropic" },
      }).success
    ).toBe(true);
    const invalid = ProviderUpdateSchema.safeParse({
      provider_type: "codex",
      protocols: ["response", "gemini"],
    });
    expect(invalid.success).toBe(false);
  });
});
