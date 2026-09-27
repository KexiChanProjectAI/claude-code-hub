import "server-only";

import type { UpstreamQuotaWindow } from "@/types/upstream-quota";
import type { UpstreamQuotaProber } from "../types";
import {
  asRecord,
  clampUsedPercent,
  fetchUpstreamQuotaJson,
  parseResetTime,
  safeHostname,
  safeOrigin,
  toFiniteNumber,
} from "./http";

const KIMI_CODING_ORIGIN = "https://api.kimi.com";

export function buildKimiCodingUsageUrl(providerUrl: string): string {
  const host = safeHostname(providerUrl);
  const origin =
    host === "api.kimi.com" ? KIMI_CODING_ORIGIN : (safeOrigin(providerUrl) ?? KIMI_CODING_ORIGIN);
  return `${origin}/coding/v1/usages`;
}

function windowFromLimitRemaining(
  name: UpstreamQuotaWindow["window"],
  raw: unknown
): UpstreamQuotaWindow | null {
  const record = asRecord(raw);
  if (!record) return null;
  const limit = toFiniteNumber(record.limit);
  const remaining = toFiniteNumber(record.remaining);
  if (limit === null || remaining === null || limit <= 0) return null;
  return {
    window: name,
    usedPercent: clampUsedPercent(((limit - remaining) / limit) * 100),
    resetAt: parseResetTime(record.resetTime ?? record.reset_time ?? record.resetAt),
  };
}

/** Parse GET /coding/v1/usages: limits[0].detail = 5h window, usage = weekly window. */
export function parseKimiCodingUsage(json: unknown): UpstreamQuotaWindow[] {
  const root = asRecord(json);
  if (!root) return [];
  const windows: UpstreamQuotaWindow[] = [];

  const limits = Array.isArray(root.limits) ? root.limits : [];
  const firstLimit = asRecord(limits[0]);
  const fiveHour = windowFromLimitRemaining("5h", firstLimit?.detail ?? firstLimit);
  if (fiveHour) windows.push(fiveHour);

  const weekly = windowFromLimitRemaining("weekly", root.usage);
  if (weekly) windows.push(weekly);

  return windows;
}

export const kimiCodingProber: UpstreamQuotaProber = {
  type: "kimi-coding",
  async probe(target) {
    const response = await fetchUpstreamQuotaJson(target, buildKimiCodingUsageUrl(target.url), {
      Authorization: `Bearer ${target.key}`,
    });
    if (!response.ok) return response;
    const root = asRecord(response.json);
    if (!root) return { ok: false, kind: "parse", message: "unexpected Kimi usage payload" };
    return { ok: true, windows: parseKimiCodingUsage(root), planLevel: null };
  },
};
