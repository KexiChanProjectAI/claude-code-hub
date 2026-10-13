import "server-only";

import { getUpstreamGzipMemorySnapshot } from "@/app/v1/_lib/proxy/upstream-compression";
import { getEnvConfig } from "@/lib/config/env.schema";
import { loadUpstreamGzipStates } from "@/lib/redis/upstream-gzip-state";
import type {
  ProviderUpstreamGzipStatus,
  ProviderUpstreamGzipStatusMap,
  UpstreamGzipRecord,
} from "@/types/upstream-gzip";

function newer<T extends { updatedAt: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/**
 * 合并 Redis（全部 worker 的观测）与本进程内存快照（无 Redis 的单进程部署），
 * 同一方向取最近一次状态变化。关闭对应开关时直接报告 disabled。
 */
export function buildProviderUpstreamGzipStatus(
  record: UpstreamGzipRecord | undefined,
  flags: { requestEnabled: boolean; responseEnabled: boolean }
): ProviderUpstreamGzipStatus {
  return {
    request: flags.requestEnabled
      ? record?.request
        ? { ...record.request }
        : { state: "unknown", updatedAt: null }
      : { state: "disabled", updatedAt: null },
    response: flags.responseEnabled
      ? record?.response
        ? { ...record.response }
        : { state: "unknown", updatedAt: null }
      : { state: "disabled", updatedAt: null },
  };
}

export async function buildProviderUpstreamGzipStatusMap(
  providerIds: number[]
): Promise<ProviderUpstreamGzipStatusMap> {
  const env = getEnvConfig();
  const flags = {
    requestEnabled: env.ENABLE_UPSTREAM_REQUEST_GZIP,
    responseEnabled: env.ENABLE_UPSTREAM_RESPONSE_GZIP,
  };
  const [stored, memory] = [
    await loadUpstreamGzipStates(providerIds),
    getUpstreamGzipMemorySnapshot(),
  ];

  const result: ProviderUpstreamGzipStatusMap = {};
  for (const id of providerIds) {
    const a = stored.get(id);
    const b = memory.get(id);
    const merged: UpstreamGzipRecord = {
      request: newer(a?.request, b?.request),
      response: newer(a?.response, b?.response),
    };
    result[id] = buildProviderUpstreamGzipStatus(merged, flags);
  }
  return result;
}
