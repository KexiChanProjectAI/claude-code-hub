import { logger } from "@/lib/logger";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import type { Key } from "@/types/key";
import type { User } from "@/types/user";

export type KeyValidationReason =
  | "valid"
  | "key_not_found"
  | "key_disabled"
  | "key_expired"
  | "user_disabled"
  | "user_expired"
  | "server_error";

export type KeyValidationResult =
  | {
      valid: true;
      reason: "valid";
      user: User;
      key: Key;
    }
  | {
      valid: false;
      reason: Exclude<KeyValidationReason, "valid">;
      user?: undefined;
      key?: undefined;
    };

/**
 * Validate an API key string for administrative diagnostic purposes.
 *
 * This reuses the same repository-level lookup (`resolveApiKeyAuthOutcome`)
 * that the proxy auth guard uses, but skips the proxy's brute-force rate
 * limiting so admins can safely probe keys.
 */
export async function validateKeyString(keyString: string): Promise<KeyValidationResult> {
  try {
    const outcome = await resolveApiKeyAuthOutcome(keyString);

    if (!outcome.ok) {
      return {
        valid: false,
        reason: outcome.reason === "not_found" ? "key_not_found" : outcome.reason,
      };
    }

    const { user, key } = outcome;

    if (!user.isEnabled) {
      return { valid: false, reason: "user_disabled" };
    }

    if (user.expiresAt && user.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: "user_expired" };
    }

    return { valid: true, reason: "valid", user, key };
  } catch (error) {
    logger.error({ action: "key_validate_failed", keyPrefix: keyString.slice(0, 8) }, error);
    return { valid: false, reason: "server_error" };
  }
}
