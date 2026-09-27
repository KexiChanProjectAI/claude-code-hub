import { describe, expect, test } from "vitest";
import {
  hasProviderBatchPatchChanges,
  normalizeProviderBatchPatchDraft,
  prepareProviderBatchApplyUpdates,
} from "@/lib/provider-patch-contract";

describe("provider batch patch - upstream quota fields", () => {
  test("sets probe type and threshold", () => {
    const result = prepareProviderBatchApplyUpdates({
      upstream_quota_probe_type: { set: "zhipu-coding" },
      upstream_quota_threshold_percent: { set: 25 },
    });
    expect(result).toEqual({
      ok: true,
      data: { upstream_quota_probe_type: "zhipu-coding", upstream_quota_threshold_percent: 25 },
    });
  });

  test("clears the threshold override", () => {
    const result = prepareProviderBatchApplyUpdates({
      upstream_quota_threshold_percent: { clear: true },
    });
    expect(result).toEqual({ ok: true, data: { upstream_quota_threshold_percent: null } });
  });

  test("rejects invalid values and clearing the probe type", () => {
    expect(
      normalizeProviderBatchPatchDraft({ upstream_quota_probe_type: { set: "deepseek" } }).ok
    ).toBe(false);
    expect(
      normalizeProviderBatchPatchDraft({ upstream_quota_probe_type: { clear: true } }).ok
    ).toBe(false);
    for (const bad of [0, 100, 12.5, "10"]) {
      expect(
        normalizeProviderBatchPatchDraft({ upstream_quota_threshold_percent: { set: bad } }).ok
      ).toBe(false);
    }
  });

  test("counts as a change", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      upstream_quota_probe_type: { set: "none" },
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(hasProviderBatchPatchChanges(normalized.data)).toBe(true);

    const empty = normalizeProviderBatchPatchDraft({});
    if (empty.ok) expect(hasProviderBatchPatchChanges(empty.data)).toBe(false);
  });
});
