import { getEnvConfig } from "@/lib/config/env.schema";
import { safeEquals } from "../responses-ws/internal-secret";

export const EDGE_SECRET_HEADER = "x-cch-edge-secret";

export type EdgeAuthResult = "ok" | "not_configured" | "unauthorized";

/**
 * 校验 edge 执行器的节点间共享密钥。
 *
 * 密钥来自 CCH_EDGE_SHARED_SECRET；未配置时整个 edge 控制面视为关闭。
 * 比较使用常量时间实现，且密钥绝不写入日志。
 */
export function verifyEdgeRequest(headers: Headers): EdgeAuthResult {
  const expected = getEnvConfig().CCH_EDGE_SHARED_SECRET;
  if (!expected) return "not_configured";
  const provided = headers.get(EDGE_SECRET_HEADER);
  if (!provided) return "unauthorized";
  return safeEquals(provided, expected) ? "ok" : "unauthorized";
}
