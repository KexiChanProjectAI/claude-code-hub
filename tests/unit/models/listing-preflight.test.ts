import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: { filterByLimits: vi.fn() },
}));
vi.mock("@/app/v1/_lib/proxy/version-guard", () => ({ isClientVersionRejected: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { listingClientSubject } from "@/app/v1/_lib/models/client-scope";
import {
  findUnhealthyProviderIds,
  isListingClientRejected,
  resetListingPreflightForTests,
} from "@/app/v1/_lib/models/listing-preflight";
import { ProxyProviderResolver } from "@/app/v1/_lib/proxy/provider-selector";
import { isClientVersionRejected } from "@/app/v1/_lib/proxy/version-guard";
import type { Provider } from "@/types/provider";

const p = (id: number) => ({ id }) as unknown as Provider;
const codex = () =>
  listingClientSubject(
    new Headers({ "user-agent": "codex_cli_rs/0.167.0 (Debian 13; x86_64) xterm" }),
    "/v1/codex/models"
  );

describe("isListingClientRejected", () => {
  beforeEach(() => {
    vi.mocked(isClientVersionRejected).mockReset().mockResolvedValue(false);
  });

  it("allows unrestricted users with a current client", async () => {
    expect(await isListingClientRejected(codex(), {})).toBe(false);
    expect(isClientVersionRejected).toHaveBeenCalledWith(
      "codex_cli_rs/0.167.0 (Debian 13; x86_64) xterm"
    );
  });

  it("rejects clients outside the user allowlist or on the blocklist", async () => {
    expect(await isListingClientRejected(codex(), { allowedClients: ["gemini-cli"] })).toBe(true);
    expect(await isListingClientRejected(codex(), { blockedClients: ["codex-cli"] })).toBe(true);
    expect(await isListingClientRejected(codex(), { allowedClients: ["codex-cli"] })).toBe(false);
    expect(isClientVersionRejected).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing user agent only when an allowlist is set", async () => {
    const bare = listingClientSubject(new Headers(), "/v1/models");
    expect(await isListingClientRejected(bare, { allowedClients: ["codex-cli"] })).toBe(true);
    expect(await isListingClientRejected(bare, { blockedClients: ["codex-cli"] })).toBe(false);
  });

  it("rejects outdated clients", async () => {
    vi.mocked(isClientVersionRejected).mockResolvedValueOnce(true);
    expect(await isListingClientRejected(codex(), {})).toBe(true);
  });
});

describe("findUnhealthyProviderIds", () => {
  beforeEach(() => {
    resetListingPreflightForTests();
    vi.mocked(ProxyProviderResolver.filterByLimits).mockReset();
  });

  it("returns the providers the router's health filter drops", async () => {
    vi.mocked(ProxyProviderResolver.filterByLimits).mockResolvedValueOnce([p(1), p(3)]);
    expect([...(await findUnhealthyProviderIds([p(1), p(2), p(3)]))]).toEqual([2]);
  });

  it("skips the check for an empty candidate list", async () => {
    expect((await findUnhealthyProviderIds([])).size).toBe(0);
    expect(ProxyProviderResolver.filterByLimits).not.toHaveBeenCalled();
  });

  it("reuses verdicts briefly per candidate set", async () => {
    vi.mocked(ProxyProviderResolver.filterByLimits).mockResolvedValue([p(1)]);
    await findUnhealthyProviderIds([p(2), p(1)]);
    expect([...(await findUnhealthyProviderIds([p(1), p(2)]))]).toEqual([2]);
    expect(ProxyProviderResolver.filterByLimits).toHaveBeenCalledTimes(1);
    await findUnhealthyProviderIds([p(1)]);
    expect(ProxyProviderResolver.filterByLimits).toHaveBeenCalledTimes(2);
  });

  it("fails open when the health check throws", async () => {
    vi.mocked(ProxyProviderResolver.filterByLimits).mockRejectedValueOnce(new Error("redis"));
    expect((await findUnhealthyProviderIds([p(1)])).size).toBe(0);
    vi.mocked(ProxyProviderResolver.filterByLimits).mockResolvedValueOnce([]);
    expect([...(await findUnhealthyProviderIds([p(1)]))]).toEqual([1]);
  });
});
