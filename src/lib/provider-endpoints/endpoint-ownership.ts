import type { ProviderType } from "@/types/provider";

export type EndpointOwnershipProvider = {
  url: string;
  providerVendorId: number | null;
  providerType: ProviderType;
  isEnabled: boolean;
};

export type ForeignOwnedEndpointScope = {
  /** Exact home URLs of other enabled providers in this vendor/type pool. */
  urls: string[];
  /**
   * Origins of those sibling home URLs when they differ from the selected
   * provider. Same-host path siblings stay URL-only so extras on this host
   * remain eligible; different-host siblings must not receive any traffic.
   */
  origins: string[];
};

export function readHttpOrigin(raw: string): string | null {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Scope that other enabled providers own inside a shared vendor/type pool.
 *
 * Providers cluster onto one vendor by websiteUrl hostname or by URL host:port.
 * Adding two keys with different hosts (common when creating under a vendor
 * that already has websiteUrl) would otherwise let latency ranking / hedge
 * send provider A's key to provider B's host.
 */
export function collectForeignOwnedEndpointScope(input: {
  providers: readonly EndpointOwnershipProvider[];
  vendorId: number;
  providerType: ProviderType;
  homeUrl: string;
}): ForeignOwnedEndpointScope {
  const homeUrl = input.homeUrl.trim();
  const homeOrigin = readHttpOrigin(homeUrl);
  const urls = new Set<string>();
  const origins = new Set<string>();

  for (const provider of input.providers) {
    if (!provider.isEnabled) continue;
    if (provider.providerVendorId !== input.vendorId) continue;
    if (provider.providerType !== input.providerType) continue;

    const url = provider.url.trim();
    if (!url || url === homeUrl) continue;
    urls.add(url);

    const origin = readHttpOrigin(url);
    if (origin && origin !== homeOrigin) {
      origins.add(origin);
    }
  }

  return { urls: [...urls], origins: [...origins] };
}
