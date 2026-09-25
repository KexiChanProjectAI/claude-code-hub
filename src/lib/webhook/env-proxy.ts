import { resolveOutboundProxyUrl } from "@/lib/outbound-proxy";

/**
 * Resolve an HTTP/SOCKS proxy URL for webhook delivery.
 * Target-level proxyUrl wins; otherwise OUTBOUND_PROXY_URL; otherwise
 * PROXY / HTTPS_PROXY / HTTP_PROXY / ALL_PROXY.
 */
export function resolveWebhookProxyUrl(
  configured?: string | null,
  targetUrl = "https://example.com"
): string | null {
  return resolveOutboundProxyUrl({
    explicit: configured,
    targetUrl,
    legacyEnv: true,
  }).proxyUrl;
}
