import "server-only";

import type { UpstreamQuotaWindow } from "@/types/upstream-quota";
import type { UpstreamQuotaProber } from "../types";
import {
  asRecord,
  clampUsedPercent,
  fetchUpstreamQuotaJson,
  parseResetTime,
  safeHostname,
  toFiniteNumber,
} from "./http";

const REMAINS_PATH = "/v1/api/openplatform/coding_plan/remains";

export function buildMiniMaxRemainsUrl(providerUrl: string): string {
  const host = safeHostname(providerUrl);
  const origin =
    host === "minimax.io" || host.endsWith(".minimax.io")
      ? "https://api.minimax.io"
      : "https://api.minimaxi.com";
  return `${origin}${REMAINS_PATH}`;
}

/** Parse coding_plan/remains: model_remains[model_name=general] carries interval and weekly remaining percent. */
export function parseMiniMaxRemains(json: unknown): {
  windows: UpstreamQuotaWindow[];
  planLevel: string | null;
} {
  const root = asRecord(json);
  const entries = (Array.isArray(root?.model_remains) ? root.model_remains : [])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const general = entries.find((entry) => entry.model_name === "general") ?? entries[0];
  if (!general) return { windows: [], planLevel: null };

  const windows: UpstreamQuotaWindow[] = [];
  const intervalRemaining = toFiniteNumber(general.current_interval_remaining_percent);
  if (intervalRemaining !== null) {
    windows.push({
      window: "5h",
      usedPercent: clampUsedPercent(100 - intervalRemaining),
      resetAt: parseResetTime(general.end_time),
    });
  }

  const weeklyStatus = toFiniteNumber(general.current_weekly_status);
  const weeklyRemaining = toFiniteNumber(general.current_weekly_remaining_percent);
  if (weeklyStatus === 1 && weeklyRemaining !== null) {
    windows.push({
      window: "weekly",
      usedPercent: clampUsedPercent(100 - weeklyRemaining),
      resetAt: parseResetTime(general.weekly_end_time),
    });
  }

  const title = general.current_subscribe_title;
  return { windows, planLevel: typeof title === "string" && title ? title : null };
}

export const miniMaxCodingProber: UpstreamQuotaProber = {
  type: "minimax-coding",
  async probe(target) {
    const response = await fetchUpstreamQuotaJson(target, buildMiniMaxRemainsUrl(target.url), {
      Authorization: `Bearer ${target.key}`,
    });
    if (!response.ok) return response;
    const root = asRecord(response.json);
    if (!root) return { ok: false, kind: "parse", message: "unexpected MiniMax remains payload" };
    const baseResp = asRecord(root.base_resp);
    const statusCode = toFiniteNumber(baseResp?.status_code);
    if (statusCode !== null && statusCode !== 0) {
      const message =
        typeof baseResp?.status_msg === "string" && baseResp.status_msg
          ? baseResp.status_msg
          : `MiniMax status_code ${statusCode}`;
      return {
        ok: false,
        kind: statusCode === 1004 ? "credential_invalid" : "http_error",
        statusCode: response.status,
        message,
      };
    }
    const { windows, planLevel } = parseMiniMaxRemains(root);
    return { ok: true, windows, planLevel };
  },
};
