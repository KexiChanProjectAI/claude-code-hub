import "server-only";

import type { UpstreamQuotaWindow } from "@/types/upstream-quota";
import type { UpstreamQuotaProber, UpstreamQuotaProbeTarget } from "../types";
import {
  asRecord,
  clampUsedPercent,
  fetchUpstreamQuotaJson,
  parseResetTime,
  safeHostname,
  safeOrigin,
  toFiniteNumber,
} from "./http";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";

export function buildZhipuQuotaUrl(
  target: Pick<UpstreamQuotaProbeTarget, "url" | "upstreamQuotaProbeOptions">
): string {
  const host = safeHostname(target.url);
  let origin: string;
  if (host === "z.ai" || host.endsWith(".z.ai")) {
    origin = "https://api.z.ai";
  } else if (host === "bigmodel.cn" || host.endsWith(".bigmodel.cn")) {
    origin = "https://open.bigmodel.cn";
  } else {
    origin = safeOrigin(target.url) ?? "https://open.bigmodel.cn";
  }
  const isTeam = Boolean(target.upstreamQuotaProbeOptions?.zhipuOrganization?.trim());
  return `${origin}${QUOTA_PATH}${isTeam ? "?type=2" : ""}`;
}

/**
 * Parse Zhipu quota limits. TOKENS_LIMIT entries are preferred over CREDIT_LIMIT.
 * unit 3 = 5h window, unit 6 = weekly window; unknown units are assigned by reset order.
 */
export function parseZhipuQuotaLimits(json: unknown): {
  windows: UpstreamQuotaWindow[];
  planLevel: string | null;
} {
  const data = asRecord(asRecord(json)?.data);
  if (!data) return { windows: [], planLevel: null };
  const planLevel = typeof data.level === "string" && data.level ? data.level : null;
  const limits = (Array.isArray(data.limits) ? data.limits : [])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const tokenLimits = limits.filter((entry) => entry.type === "TOKENS_LIMIT");
  const chosen =
    tokenLimits.length > 0 ? tokenLimits : limits.filter((entry) => entry.type === "CREDIT_LIMIT");

  const parsed = chosen
    .map((entry) => {
      const percentage = toFiniteNumber(entry.percentage);
      if (percentage === null) return null;
      return {
        unit: toFiniteNumber(entry.unit),
        usedPercent: clampUsedPercent(percentage),
        resetAt: parseResetTime(entry.nextResetTime),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(
      (a, b) => (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER)
    );

  const windows: UpstreamQuotaWindow[] = [];
  const used = new Set<UpstreamQuotaWindow["window"]>();
  for (const entry of parsed) {
    let name: UpstreamQuotaWindow["window"] | null =
      entry.unit === 3 ? "5h" : entry.unit === 6 ? "weekly" : null;
    if (!name || used.has(name)) {
      name = !used.has("5h") ? "5h" : !used.has("weekly") ? "weekly" : null;
    }
    if (!name) continue;
    used.add(name);
    windows.push({ window: name, usedPercent: entry.usedPercent, resetAt: entry.resetAt });
  }
  return { windows, planLevel };
}

export const zhipuCodingProber: UpstreamQuotaProber = {
  type: "zhipu-coding",
  async probe(target) {
    const headers: Record<string, string> = {
      Authorization: target.key,
      "Accept-Language": "en-US,en",
    };
    const organization = target.upstreamQuotaProbeOptions?.zhipuOrganization?.trim();
    const project = target.upstreamQuotaProbeOptions?.zhipuProject?.trim();
    if (organization) headers["bigmodel-organization"] = organization;
    if (organization && project) headers["bigmodel-project"] = project;

    const response = await fetchUpstreamQuotaJson(target, buildZhipuQuotaUrl(target), headers);
    if (!response.ok) return response;
    const root = asRecord(response.json);
    if (!root) return { ok: false, kind: "parse", message: "unexpected Zhipu quota payload" };
    if (root.success === false) {
      const message =
        typeof root.msg === "string" && root.msg ? root.msg : "Zhipu quota query failed";
      const code = toFiniteNumber(root.code);
      return {
        ok: false,
        kind:
          code === 401 || code === 1000 || code === 1001 || code === 1002
            ? "credential_invalid"
            : "http_error",
        statusCode: response.status,
        message,
      };
    }
    const { windows, planLevel } = parseZhipuQuotaLimits(root);
    return { ok: true, windows, planLevel };
  },
};
