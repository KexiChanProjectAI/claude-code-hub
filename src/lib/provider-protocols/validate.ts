import type { ProviderProtocol, ProviderType } from "@/types/provider";
import { ALL_PROVIDER_PROTOCOLS, MULTI_PROTOCOL_IDS, protocolOfProviderType } from "./expand";

export interface ProviderProtocolsValidationIssue {
  path: "protocols" | "protocol_urls";
  message: string;
}

const MULTI: ReadonlySet<string> = new Set(MULTI_PROTOCOL_IDS);

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate submitted `protocols` / `protocol_urls` (snake_case API input).
 *
 * `providerType` may be undefined on partial updates; checks that need it are skipped then and
 * the repository normalizes against the stored type. The primary protocol is always served, so
 * it is not required in `protocols`.
 */
export function validateProviderProtocolsInput(input: {
  providerType?: ProviderType | null;
  protocols?: readonly string[] | null;
  protocolUrls?: Record<string, unknown> | null;
}): ProviderProtocolsValidationIssue[] {
  const issues: ProviderProtocolsValidationIssue[] = [];
  const protocols = input.protocols ?? null;
  const primaryProtocol = input.providerType ? protocolOfProviderType(input.providerType) : null;

  if (protocols) {
    const unknown = protocols.filter(
      (protocol) => !(ALL_PROVIDER_PROTOCOLS as readonly string[]).includes(protocol)
    );
    if (unknown.length > 0) {
      issues.push({ path: "protocols", message: `Unknown protocols: ${unknown.join(", ")}` });
    }

    const nonMulti = protocols.filter(
      (protocol) => !MULTI.has(protocol) && protocol !== primaryProtocol
    );
    const geminiPrimary = primaryProtocol !== null && !MULTI.has(primaryProtocol);
    if (geminiPrimary) {
      const extra = protocols.filter((protocol) => protocol !== primaryProtocol);
      if (extra.length > 0) {
        issues.push({
          path: "protocols",
          message: `${input.providerType} providers serve only their own protocol`,
        });
      }
    } else if (nonMulti.length > 0 && unknown.length === 0) {
      issues.push({
        path: "protocols",
        message: "Only claude, openai and response can be combined on one provider",
      });
    }
  }

  const protocolUrls = input.protocolUrls ?? null;
  if (protocolUrls) {
    for (const [key, value] of Object.entries(protocolUrls)) {
      if (!(ALL_PROVIDER_PROTOCOLS as readonly string[]).includes(key)) {
        issues.push({ path: "protocol_urls", message: `Unknown protocol: ${key}` });
        continue;
      }
      const protocol = key as ProviderProtocol;
      if (primaryProtocol && protocol === primaryProtocol) {
        issues.push({
          path: "protocol_urls",
          message: `The primary protocol ${protocol} uses the provider url; remove its override`,
        });
        continue;
      }
      if (protocols && !protocols.includes(protocol)) {
        issues.push({
          path: "protocol_urls",
          message: `URL override for ${protocol}, which is not in protocols`,
        });
        continue;
      }
      if (typeof value !== "string" || !isHttpUrl(value.trim())) {
        issues.push({
          path: "protocol_urls",
          message: `URL override for ${protocol} must be an http(s) URL`,
        });
      }
    }
  }

  return issues;
}
