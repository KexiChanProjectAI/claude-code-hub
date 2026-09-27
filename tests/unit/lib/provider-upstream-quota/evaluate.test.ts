import { describe, expect, test } from "vitest";
import {
  describeUpstreamQuotaVerdict,
  evaluateUpstreamQuota,
  type UpstreamQuotaSettings,
} from "@/lib/provider-upstream-quota/evaluate";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const settings: UpstreamQuotaSettings = {
  enabled: true,
  thresholdPercent: 10,
  intervalMinutes: 10,
};

function snapshot(overrides: Partial<UpstreamQuotaSnapshot> = {}): UpstreamQuotaSnapshot {
  return {
    providerId: 1,
    probeType: "kimi-coding",
    windows: [
      { window: "5h", usedPercent: 50, resetAt: NOW + HOUR },
      { window: "weekly", usedPercent: 20, resetAt: NOW + 48 * HOUR },
    ],
    planLevel: null,
    credentialValid: true,
    lastError: null,
    lastErrorStatus: null,
    fetchedAt: NOW - 60_000,
    probedAt: NOW - 60_000,
    reactivePauseUntil: null,
    reactivePauseReason: null,
    ...overrides,
  };
}

const evaluate = (
  snap: UpstreamQuotaSnapshot | null,
  opts: Partial<{
    settings: UpstreamQuotaSettings;
    type: "kimi-coding" | "none";
    override: number | null;
  }> = {}
) =>
  evaluateUpstreamQuota({
    snapshot: snap,
    settings: opts.settings ?? settings,
    resolvedProbeType: opts.type ?? "kimi-coding",
    providerThresholdPercent: opts.override ?? null,
    now: NOW,
  });

describe("evaluateUpstreamQuota", () => {
  test("disabled feature always allows", () => {
    expect(
      evaluate(snapshot({ reactivePauseUntil: NOW + HOUR }), {
        settings: { ...settings, enabled: false },
      })
    ).toEqual({ status: "ok", reason: "disabled" });
  });

  test("reactive pause wins over window data and applies to untracked probe types", () => {
    expect(evaluate(snapshot({ reactivePauseUntil: NOW + 1 })).status).toBe("exhausted");
    expect(evaluate(snapshot({ reactivePauseUntil: NOW + 1 }), { type: "none" })).toMatchObject({
      status: "exhausted",
      reason: "reactive_pause",
    });
    expect(evaluate(snapshot({ reactivePauseUntil: NOW - 1 })).status).toBe("ok");
  });

  test("probe type none without pause is not applicable", () => {
    expect(evaluate(snapshot(), { type: "none" })).toEqual({
      status: "ok",
      reason: "not_applicable",
    });
  });

  test("missing or stale snapshots are unknown and never block", () => {
    expect(evaluate(null)).toEqual({ status: "unknown", reason: "no_snapshot" });
    expect(evaluate(snapshot({ fetchedAt: null }))).toEqual({
      status: "unknown",
      reason: "no_snapshot",
    });
    expect(evaluate(snapshot({ fetchedAt: NOW - 31 * 60_000 }))).toEqual({
      status: "unknown",
      reason: "stale_snapshot",
    });
    expect(evaluate(snapshot({ fetchedAt: NOW - 29 * 60_000 })).status).toBe("ok");
  });

  test("uses the minimum remaining across active windows", () => {
    const verdict = evaluate(
      snapshot({
        windows: [
          { window: "5h", usedPercent: 30, resetAt: NOW + HOUR },
          { window: "weekly", usedPercent: 95, resetAt: NOW + 24 * HOUR },
        ],
      })
    );
    expect(verdict).toMatchObject({
      status: "low",
      reason: "below_threshold",
      remainingPercent: 5,
      blockingWindow: "weekly",
      thresholdPercent: 10,
    });
  });

  test("ignores windows whose reset time has passed", () => {
    const verdict = evaluate(
      snapshot({
        windows: [
          { window: "5h", usedPercent: 100, resetAt: NOW - 1 },
          { window: "weekly", usedPercent: 40, resetAt: null },
        ],
      })
    );
    expect(verdict).toMatchObject({ status: "ok", remainingPercent: 60, blockingWindow: "weekly" });
    expect(
      evaluate(snapshot({ windows: [{ window: "5h", usedPercent: 100, resetAt: NOW - 1 }] }))
    ).toMatchObject({ status: "ok", reason: "no_active_window" });
  });

  test("zero remaining is exhausted", () => {
    expect(
      evaluate(snapshot({ windows: [{ window: "5h", usedPercent: 100, resetAt: NOW + HOUR }] }))
    ).toMatchObject({ status: "exhausted", reason: "exhausted", remainingPercent: 0 });
    expect(
      evaluate(snapshot({ windows: [{ window: "5h", usedPercent: 140, resetAt: NOW + HOUR }] }))
        .status
    ).toBe("exhausted");
  });

  test("provider threshold overrides the global threshold", () => {
    const snap = snapshot({ windows: [{ window: "5h", usedPercent: 75, resetAt: NOW + HOUR }] });
    expect(evaluate(snap).status).toBe("ok");
    expect(evaluate(snap, { override: 30 })).toMatchObject({
      status: "low",
      thresholdPercent: 30,
    });
  });

  test("equal to threshold is still allowed", () => {
    const snap = snapshot({ windows: [{ window: "5h", usedPercent: 90, resetAt: NOW + HOUR }] });
    expect(evaluate(snap).status).toBe("ok");
  });
});

describe("describeUpstreamQuotaVerdict", () => {
  test("formats decision chain details without decimal points", () => {
    expect(describeUpstreamQuotaVerdict({ status: "exhausted", reason: "reactive_pause" })).toBe(
      "upstream_balance_exhausted"
    );
    expect(describeUpstreamQuotaVerdict({ status: "unknown", reason: "no_snapshot" })).toBe(
      "no_snapshot"
    );
    expect(
      describeUpstreamQuotaVerdict({
        status: "low",
        reason: "below_threshold",
        remainingPercent: 5.75,
        blockingWindow: "5h",
        thresholdPercent: 10,
      })
    ).toBe("5h remaining 5% < 10%");
    expect(
      describeUpstreamQuotaVerdict({
        status: "low",
        reason: "below_threshold",
        remainingPercent: 0.4,
        thresholdPercent: 10,
      })
    ).toBe("window remaining <1% < 10%");
    expect(
      describeUpstreamQuotaVerdict({
        status: "exhausted",
        reason: "exhausted",
        remainingPercent: 0,
        blockingWindow: "weekly",
        thresholdPercent: 10,
      })
    ).toBe("weekly remaining 0%");
  });
});
