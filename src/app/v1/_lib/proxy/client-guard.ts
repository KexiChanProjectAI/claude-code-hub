import { isClientAllowedDetailed } from "./client-detector";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

type ClientRestrictedUser = {
  allowedClients?: string[] | null;
  blockedClients?: string[] | null;
};

export type UserClientVerdict = { allowed: true } | { allowed: false; message: string };

/**
 * User-level client restriction verdict. Shared by the proxy guard and model listings, so a
 * listing never advertises models to a client the guard would reject.
 */
export function checkUserClient(
  session: ProxySession,
  user: ClientRestrictedUser
): UserClientVerdict {
  const allowedClients = user.allowedClients ?? [];
  const blockedClients = user.blockedClients ?? [];

  if (allowedClients.length === 0 && blockedClients.length === 0) {
    return { allowed: true };
  }

  // User-Agent is only required when an allowlist is configured.
  // Blocklist-only: no UA can't match any block pattern, so the request passes through.
  const userAgent = session.userAgent?.trim();
  if (!userAgent && allowedClients.length > 0) {
    return {
      allowed: false,
      message:
        "Client not allowed. User-Agent header is required when client restrictions are configured.",
    };
  }

  const result = isClientAllowedDetailed(session, allowedClients, blockedClients);
  if (!result.allowed) {
    const detected = result.detectedClient ? ` (detected: ${result.detectedClient})` : "";
    return {
      allowed: false,
      message:
        result.matchType === "blocklist_hit"
          ? `Client blocked${detected}`
          : `Client not allowed${detected}`,
    };
  }

  return { allowed: true };
}

export class ProxyClientGuard {
  static async ensure(session: ProxySession): Promise<Response | null> {
    const user = session.authState?.user;
    if (!user) {
      // No user context - skip check (authentication should have failed already)
      return null;
    }

    const verdict = checkUserClient(session, user);
    if (!verdict.allowed) {
      return ProxyResponses.buildError(400, verdict.message, "invalid_request_error");
    }

    // Client is allowed
    return null;
  }
}
