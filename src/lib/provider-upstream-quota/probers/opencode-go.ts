import "server-only";

import type { UpstreamQuotaWindow } from "@/types/upstream-quota";
import type { UpstreamQuotaProber } from "../types";
import {
  asRecord,
  clampUsedPercent,
  fetchUpstreamQuotaJson,
  parseResetTime,
  toFiniteNumber,
} from "./http";

const ENDPOINT_SUFFIXES = ["/chat/completions", "/messages", "/responses", "/models"];

export function buildOpenCodeGoUsageUrl(providerUrl: string): string {
  let base = providerUrl.trim().replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return `${base}/usage`;
}

/** Parse GET <base>/usage: usage.{rolling,weekly,monthly}.{percent,resetsAt} (percent = used). */
export function parseOpenCodeGoUsage(json: unknown): UpstreamQuotaWindow[] {
  const usage = asRecord(asRecord(json)?.usage);
  if (!usage) return [];
  const windows: UpstreamQuotaWindow[] = [];
  for (const name of ["rolling", "weekly", "monthly"] as const) {
    const entry = asRecord(usage[name]);
    const percent = toFiniteNumber(entry?.percent);
    if (!entry || percent === null) continue;
    windows.push({
      window: name,
      usedPercent: clampUsedPercent(percent),
      resetAt: parseResetTime(entry.resetsAt ?? entry.resets_at),
    });
  }
  return windows;
}

export const openCodeGoProber: UpstreamQuotaProber = {
  type: "opencode-go",
  async probe(target) {
    const response = await fetchUpstreamQuotaJson(target, buildOpenCodeGoUsageUrl(target.url), {
      Authorization: `Bearer ${target.key}`,
    });
    if (!response.ok) return response;
    if (!asRecord(response.json)) {
      return { ok: false, kind: "parse", message: "unexpected OpenCode Go usage payload" };
    }
    return { ok: true, windows: parseOpenCodeGoUsage(response.json), planLevel: null };
  },
};
