import { describe, expect, test } from "vitest";
import { collectForeignOwnedEndpointScope } from "@/lib/provider-endpoints/endpoint-ownership";
import type { ProviderType } from "@/types/provider";

function provider(overrides: {
  url: string;
  providerVendorId?: number | null;
  providerType?: ProviderType;
  isEnabled?: boolean;
}) {
  return {
    url: overrides.url,
    providerVendorId: overrides.providerVendorId ?? 1,
    providerType: overrides.providerType ?? "claude",
    isEnabled: overrides.isEnabled ?? true,
  };
}

describe("collectForeignOwnedEndpointScope", () => {
  test("same-host siblings exclude exact URLs but not the shared origin", () => {
    const scope = collectForeignOwnedEndpointScope({
      providers: [
        provider({ url: "https://relay.example/a" }),
        provider({ url: "https://relay.example/b" }),
        provider({ url: "https://relay.example/backup" }),
      ],
      vendorId: 1,
      providerType: "claude",
      homeUrl: "https://relay.example/a",
    });

    expect(scope.urls.sort()).toEqual(["https://relay.example/b", "https://relay.example/backup"]);
    expect(scope.origins).toEqual([]);
  });

  test("different-host siblings exclude the foreign origin even with the same key/protocol", () => {
    const scope = collectForeignOwnedEndpointScope({
      providers: [
        provider({ url: "https://host-a.example/v1" }),
        provider({ url: "https://host-b.example/v1" }),
      ],
      vendorId: 1,
      providerType: "claude",
      homeUrl: "https://host-a.example/v1",
    });

    expect(scope.urls).toEqual(["https://host-b.example/v1"]);
    expect(scope.origins).toEqual(["https://host-b.example"]);
  });

  test("keeps a shared home URL when multiple providers use the same endpoint", () => {
    const scope = collectForeignOwnedEndpointScope({
      providers: [
        provider({ url: "https://api.example/v1" }),
        provider({ url: "https://api.example/v1" }),
        provider({ url: "https://api.example/backup" }),
      ],
      vendorId: 1,
      providerType: "claude",
      homeUrl: "https://api.example/v1",
    });

    expect(scope.urls).toEqual(["https://api.example/backup"]);
    expect(scope.origins).toEqual([]);
  });

  test("ignores disabled providers, other vendors, and other types", () => {
    const scope = collectForeignOwnedEndpointScope({
      providers: [
        provider({ url: "https://relay.example/a" }),
        provider({ url: "https://relay.example/disabled", isEnabled: false }),
        provider({ url: "https://other.example/x", providerVendorId: 2 }),
        provider({ url: "https://relay.example/codex", providerType: "codex" }),
        provider({ url: "  https://relay.example/b  " }),
      ],
      vendorId: 1,
      providerType: "claude",
      homeUrl: " https://relay.example/a ",
    });

    expect(scope.urls).toEqual(["https://relay.example/b"]);
    expect(scope.origins).toEqual([]);
  });
});
