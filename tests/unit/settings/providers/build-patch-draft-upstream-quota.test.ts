import { describe, expect, it } from "vitest";
import { buildPatchDraftFromFormState } from "@/app/[locale]/settings/providers/_components/batch-edit/build-patch-draft";
import type { ProviderFormState } from "@/app/[locale]/settings/providers/_components/forms/provider-form/provider-form-types";

function stateWith(rateLimit: Partial<ProviderFormState["rateLimit"]>): ProviderFormState {
  return {
    batch: { isEnabled: "no_change" },
    rateLimit: {
      upstreamQuotaProbeType: "auto",
      upstreamQuotaThresholdPercent: null,
      upstreamQuotaZhipuOrganization: "",
      upstreamQuotaZhipuProject: "",
      ...rateLimit,
    },
  } as unknown as ProviderFormState;
}

describe("buildPatchDraftFromFormState - upstream quota", () => {
  it("emits nothing when the fields are untouched", () => {
    expect(buildPatchDraftFromFormState(stateWith({}), new Set())).toEqual({});
  });

  it("sets the probe type and threshold when dirty", () => {
    const draft = buildPatchDraftFromFormState(
      stateWith({ upstreamQuotaProbeType: "none", upstreamQuotaThresholdPercent: 30 }),
      new Set(["rateLimit.upstreamQuotaProbeType", "rateLimit.upstreamQuotaThresholdPercent"])
    );
    expect(draft).toEqual({
      upstream_quota_probe_type: { set: "none" },
      upstream_quota_threshold_percent: { set: 30 },
    });
  });

  it("clears the threshold when emptied", () => {
    const draft = buildPatchDraftFromFormState(
      stateWith({ upstreamQuotaThresholdPercent: null }),
      new Set(["rateLimit.upstreamQuotaThresholdPercent"])
    );
    expect(draft).toEqual({ upstream_quota_threshold_percent: { clear: true } });
  });
});
