/** SESSION_BINDING_TTL_SECONDS 的默认值：7 天。 */
export const DEFAULT_CONFIGURED_SESSION_BINDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 解析 Session -> 供应商粘性绑定 TTL（SESSION_BINDING_TTL_SECONDS）。
 * 缺失或非法时回落默认 7 天；与 SESSION_TTL（请求快照等短期数据）解耦。
 */
export function resolveSessionBindingTtlSeconds(
  raw: string | undefined = process.env.SESSION_BINDING_TTL_SECONDS
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONFIGURED_SESSION_BINDING_TTL_SECONDS;
}
