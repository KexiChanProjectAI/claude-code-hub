/**
 * Resolve an HTTP/SOCKS proxy URL for webhook delivery.
 * Target-level proxyUrl wins; otherwise honor PROXY / HTTPS_PROXY / HTTP_PROXY / ALL_PROXY.
 */
export function resolveWebhookProxyUrl(configured?: string | null): string | null {
  const fromConfig = configured?.trim();
  if (fromConfig) return fromConfig;

  const envKeys = [
    "PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;

  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  return null;
}
