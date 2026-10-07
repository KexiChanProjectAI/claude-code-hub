import type { Context } from "hono";
import { ERROR_CODES, getErrorMessageServer } from "@/lib/utils/error-messages";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { extractApiKeyFromHeaders } from "../proxy/auth-guard";

/**
 * 从请求中提取 API Key（复用 auth-guard 的逻辑）
 */
function extractApiKey(c: Context): string | null {
  return extractApiKeyFromHeaders({
    authorization: c.req.header("authorization"),
    "x-api-key": c.req.header("x-api-key"),
    "x-goog-api-key": c.req.header("x-goog-api-key"),
  });
}

/**
 * 验证请求的 API Key 并返回用户信息
 *
 * @throws {Response} 401 错误响应（未提供凭据、无效 key、用户禁用、用户过期）
 */
export async function authenticateApiKeyRequest(c: Context): Promise<{
  user: {
    id: number;
    providerGroup: string | null;
    isEnabled: boolean;
    expiresAt?: Date | null;
    allowedModels?: string[];
  };
  key: { providerGroup: string | null; name: string };
}> {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    throw c.json({ error: { message: "未提供认证凭据", type: "authentication_error" } }, 401);
  }

  const outcome = await resolveApiKeyAuthOutcome(apiKey);
  if (!outcome.ok) {
    // Exhaustive switch: see auth-guard.ts for rationale. Adding a new
    // ApiKeyAuthFailureReason will produce a TypeScript error on the
    // exhaustiveness fallthrough until this branch is handled explicitly.
    const { getLocale } = await import("next-intl/server");
    const locale = await getLocale();
    switch (outcome.reason) {
      case "key_disabled":
        throw c.json(
          {
            error: {
              message: await getErrorMessageServer(locale, ERROR_CODES.PROXY_API_KEY_DISABLED),
              type: "key_disabled",
            },
          },
          401
        );
      case "key_expired":
        throw c.json(
          {
            error: {
              message: await getErrorMessageServer(locale, ERROR_CODES.PROXY_API_KEY_EXPIRED),
              type: "key_expired",
            },
          },
          401
        );
      case "not_found":
        throw c.json(
          {
            error: {
              message: await getErrorMessageServer(locale, ERROR_CODES.PROXY_INVALID_API_KEY),
              type: "invalid_api_key",
            },
          },
          401
        );
      default: {
        const _exhaustive: never = outcome.reason;
        throw new Error(`Unhandled auth outcome reason: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  const { user, key } = outcome;

  if (!user.isEnabled) {
    throw c.json({ error: { message: "用户账户已被禁用", type: "user_disabled" } }, 401);
  }

  if (user.expiresAt && user.expiresAt.getTime() <= Date.now()) {
    throw c.json({ error: { message: "用户账户已过期", type: "user_expired" } }, 401);
  }

  return { user, key };
}
