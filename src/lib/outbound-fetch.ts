import { logger } from "@/lib/logger";
import { resolveOutboundProxyUrl } from "@/lib/outbound-proxy";
import { fetchWithDispatcher, getCachedEgressDispatcher, maskProxyUrl } from "@/lib/proxy-agent";

const OUTBOUND_PROXY_FETCH = Symbol.for("cch.outboundProxyFetch");

type InstalledFetch = typeof fetch & { [OUTBOUND_PROXY_FETCH]?: true };

function absoluteHttpUrl(input: Parameters<typeof fetch>[0]): string | null {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof URL) {
    raw = input.href;
  } else if (
    input &&
    typeof input === "object" &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    raw = input.url;
  } else {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The undici package fetch does not recognize Node's global Request class and would
 * stringify it to "[object Request]". Unpack it into url + init so the proxy path works.
 */
function toUndiciArgs(
  input: Parameters<typeof fetch>[0],
  targetUrl: string,
  init: RequestInit | undefined
): [string | URL, RequestInit & { duplex?: "half" }] {
  if (typeof input === "string" || input instanceof URL) {
    return [input, { ...(init ?? {}) }];
  }

  const request = input as Request;
  return [
    targetUrl,
    {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      ...(request.body ? { duplex: "half" as const } : {}),
      ...(init ?? {}),
    },
  ];
}

export function installOutboundProxyFetch(): void {
  const current = globalThis.fetch as InstalledFetch;
  if (current[OUTBOUND_PROXY_FETCH]) return;

  const captured = current;
  const wrapped = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    // A caller-supplied dispatcher already decided egress; do not override it.
    if (init && "dispatcher" in init && init.dispatcher !== undefined) {
      return captured(input, init);
    }

    const targetUrl = absoluteHttpUrl(input);
    if (!targetUrl) {
      return captured(input, init);
    }

    const decision = resolveOutboundProxyUrl({
      explicit: null,
      targetUrl,
      legacyEnv: false,
    });
    if (!decision.proxyUrl) {
      return captured(input, init);
    }

    const [url, proxiedInit] = toUndiciArgs(input, targetUrl, init);
    return fetchWithDispatcher(url, {
      ...proxiedInit,
      dispatcher: getCachedEgressDispatcher(decision.proxyUrl),
    });
  }) as InstalledFetch;

  wrapped[OUTBOUND_PROXY_FETCH] = true;
  globalThis.fetch = wrapped;

  const trimmed = process.env.OUTBOUND_PROXY_URL?.trim();
  if (trimmed) {
    logger.info("outbound proxy enabled", { proxyUrl: maskProxyUrl(trimmed) });
  }
}
