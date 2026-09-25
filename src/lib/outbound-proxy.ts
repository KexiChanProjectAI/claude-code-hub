export type OutboundProxySource = "explicit" | "global" | "legacy-env" | "none";

export interface OutboundProxyDecision {
  proxyUrl: string | null;
  source: OutboundProxySource;
}

const LEGACY_ENV_KEYS = [
  "PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const ALWAYS_BYPASS_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "0.0.0.0": true,
};

function trimToEmpty(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function splitProxyToken(token: string): { host: string; port: number | null } {
  const lower = token.toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    if (end !== -1) {
      const host = lower.slice(1, end);
      const rest = lower.slice(end + 1);
      if (rest.startsWith(":")) {
        const portText = rest.slice(1);
        const port = Number(portText);
        return { host, port: portText !== "" && Number.isInteger(port) ? port : null };
      }
      return { host, port: null };
    }
  }

  const colon = lower.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(lower.slice(colon + 1))) {
    const host = lower.slice(0, colon);
    if (!host.includes(":")) {
      return { host, port: Number(lower.slice(colon + 1)) };
    }
  }

  return { host: lower, port: null };
}

function hostMatches(hostname: string, tokenHost: string): boolean {
  if (tokenHost.startsWith(".")) {
    const suffix = tokenHost.slice(1);
    return hostname === suffix || hostname.endsWith(tokenHost);
  }
  return hostname === tokenHost || hostname.endsWith(`.${tokenHost}`);
}

function isEnvProxyBypassed(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (ALWAYS_BYPASS_HOSTS[hostname]) return true;

  const raw = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!raw) return false;

  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:" || url.protocol === "wss:"
      ? 443
      : url.protocol === "http:" || url.protocol === "ws:"
        ? 80
        : null;

  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (trimmed === "*") return true;

    const parsed = splitProxyToken(trimmed);
    if (parsed.port !== null && parsed.port !== port) continue;
    if (hostMatches(hostname, parsed.host)) return true;
  }

  return false;
}

function readLegacyProxyUrl(): string {
  for (const key of LEGACY_ENV_KEYS) {
    const value = trimToEmpty(process.env[key]);
    if (value) return value;
  }
  return "";
}

export function resolveOutboundProxyUrl(args: {
  explicit?: string | null;
  targetUrl: string;
  legacyEnv?: boolean;
}): OutboundProxyDecision {
  const explicit = trimToEmpty(args.explicit);
  if (explicit) {
    return { proxyUrl: explicit, source: "explicit" };
  }

  const globalProxy = trimToEmpty(process.env.OUTBOUND_PROXY_URL);
  if (globalProxy && !isEnvProxyBypassed(args.targetUrl)) {
    return { proxyUrl: globalProxy, source: "global" };
  }

  if (args.legacyEnv) {
    const legacyProxy = readLegacyProxyUrl();
    if (legacyProxy && !isEnvProxyBypassed(args.targetUrl)) {
      return { proxyUrl: legacyProxy, source: "legacy-env" };
    }
  }

  return { proxyUrl: null, source: "none" };
}
