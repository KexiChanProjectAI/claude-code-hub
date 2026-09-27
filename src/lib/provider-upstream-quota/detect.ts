import type {
  ResolvedUpstreamQuotaProbeType,
  UpstreamQuotaConcreteProbeType,
  UpstreamQuotaProbeType,
} from "@/types/upstream-quota";
import { UPSTREAM_QUOTA_CONCRETE_PROBE_TYPES } from "@/types/upstream-quota";

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Detect the Coding Plan probe type from a provider base URL.
 *
 * Only official Coding Plan hosts are recognized (mirrors sub2api's GetCodingPlanProvider).
 * Relays and pay-as-you-go hosts resolve to "none"; admins can override explicitly.
 */
export function detectUpstreamQuotaProbeTypeFromUrl(
  rawUrl: string
): ResolvedUpstreamQuotaProbeType {
  const url = parseUrl(rawUrl);
  if (!url) return "none";
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (host === "api.kimi.com") {
    return "kimi-coding";
  }

  if (hostMatches(host, "bigmodel.cn") || hostMatches(host, "z.ai")) {
    return path.includes("/coding") || path.includes("/anthropic") ? "zhipu-coding" : "none";
  }

  if (
    hostMatches(host, "minimaxi.com") ||
    hostMatches(host, "minimax.io") ||
    hostMatches(host, "minimax.com")
  ) {
    return "minimax-coding";
  }

  if (host === "opencode.ai" && path.includes("/zen/go")) {
    return "opencode-go";
  }

  return "none";
}

export function isConcreteUpstreamQuotaProbeType(
  value: string
): value is UpstreamQuotaConcreteProbeType {
  return (UPSTREAM_QUOTA_CONCRETE_PROBE_TYPES as readonly string[]).includes(value);
}

/** Resolve the configured probe type ("auto" -> URL detection). */
export function resolveUpstreamQuotaProbeType(provider: {
  url: string;
  upstreamQuotaProbeType?: UpstreamQuotaProbeType | null;
}): ResolvedUpstreamQuotaProbeType {
  const configured = provider.upstreamQuotaProbeType ?? "auto";
  if (configured === "none") return "none";
  if (configured === "auto") return detectUpstreamQuotaProbeTypeFromUrl(provider.url);
  return isConcreteUpstreamQuotaProbeType(configured) ? configured : "none";
}

const KNOWN_CN_PLATFORM_DOMAINS = [
  "kimi.com",
  "moonshot.cn",
  "moonshot.ai",
  "bigmodel.cn",
  "z.ai",
  "minimaxi.com",
  "minimax.io",
  "minimax.com",
  "minimax.chat",
  "deepseek.com",
  "opencode.ai",
] as const;

/**
 * Whether the provider URL points at an official CN API-key platform whose
 * "insufficient balance" responses should pause the provider reactively.
 */
export function isKnownCnPlatformHost(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return KNOWN_CN_PLATFORM_DOMAINS.some((domain) => hostMatches(host, domain));
}

/** Whether upstream quota scheduling can affect this provider at all. */
export function isUpstreamQuotaTrackedProvider(provider: {
  url: string;
  upstreamQuotaProbeType?: UpstreamQuotaProbeType | null;
}): boolean {
  if (provider.upstreamQuotaProbeType === "none") return false;
  return resolveUpstreamQuotaProbeType(provider) !== "none" || isKnownCnPlatformHost(provider.url);
}
