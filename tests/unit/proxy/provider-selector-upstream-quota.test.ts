import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";
import type { UpstreamQuotaVerdict } from "@/types/upstream-quota";

vi.mock("@/lib/circuit-breaker", () => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));
vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));
const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/session-manager", () => sessionManagerMocks);
vi.mock("@/repository/provider", () => ({ findAllProviders: vi.fn(async () => []) }));

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
  },
}));
vi.mock("@/lib/rate-limit", () => rateLimitMocks);

const quotaMocks = vi.hoisted(() => ({
  verdicts: new Map<number, UpstreamQuotaVerdict>(),
  checkProviderUpstreamQuota: vi.fn(),
}));
vi.mock("@/lib/provider-upstream-quota/verdict", () => ({
  checkProviderUpstreamQuota: quotaMocks.checkProviderUpstreamQuota,
}));

import {
  ProxyProviderResolver,
  resetProviderLimitVerdictCacheForTests,
} from "@/app/v1/_lib/proxy/provider-selector";

const OK: UpstreamQuotaVerdict = { status: "ok", reason: "healthy" };
const LOW: UpstreamQuotaVerdict = {
  status: "low",
  reason: "below_threshold",
  remainingPercent: 4,
  blockingWindow: "5h",
  thresholdPercent: 10,
};
const EXHAUSTED: UpstreamQuotaVerdict = { status: "exhausted", reason: "reactive_pause" };
const UNKNOWN: UpstreamQuotaVerdict = { status: "unknown", reason: "no_snapshot" };

function provider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `p${id}`,
    url: "https://api.kimi.com/coding/v1",
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    allowedModels: null,
    providerVendorId: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    upstreamQuotaProbeType: "auto",
    upstreamQuotaThresholdPercent: null,
    ...overrides,
  } as unknown as Provider;
}

type Resolver = {
  filterByLimits(p: Provider[]): Promise<Provider[]>;
  findReusable(session: unknown): Promise<Provider | null>;
  validateAffinityCandidate(session: unknown, id: number): Promise<Provider | null>;
  pickRandomProvider(
    session: unknown,
    exclude?: number[]
  ): Promise<{
    provider: Provider | null;
    context: { filteredProviders?: Array<{ id: number; reason: string; details?: string }> };
  }>;
};
const resolver = ProxyProviderResolver as unknown as Resolver;

function session(providers: Provider[], messagesLength = 3) {
  return {
    sessionId: "s1",
    originalFormat: "claude",
    authState: null,
    shouldReuseProvider: () => true,
    getProvidersSnapshot: async () => providers,
    getOriginalModel: () => null,
    getCurrentModel: () => null,
    getMessagesLength: () => messagesLength,
    clientRequestsContext1m: () => false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderLimitVerdictCacheForTests();
  quotaMocks.verdicts.clear();
  quotaMocks.checkProviderUpstreamQuota.mockImplementation(
    async (p: Provider) => quotaMocks.verdicts.get(p.id) ?? OK
  );
});

describe("upstream quota in filterByLimits", () => {
  test("drops low and exhausted providers for new sessions, keeps ok and unknown", async () => {
    quotaMocks.verdicts.set(2, LOW);
    quotaMocks.verdicts.set(3, EXHAUSTED);
    quotaMocks.verdicts.set(4, UNKNOWN);
    const result = await resolver.filterByLimits([
      provider(1),
      provider(2),
      provider(3),
      provider(4),
    ]);
    expect(result.map((p) => p.id)).toEqual([1, 4]);
  });

  test("does not evaluate quota for providers already blocked by spend limits", async () => {
    rateLimitMocks.RateLimitService.checkTotalCostLimit.mockResolvedValueOnce({
      allowed: false,
      current: 10,
      reason: "limit",
    } as never);
    const blocked = provider(5, { limitTotalUsd: 10 } as Partial<Provider>);
    expect(await resolver.filterByLimits([blocked])).toEqual([]);
    expect(quotaMocks.checkProviderUpstreamQuota).not.toHaveBeenCalled();
  });
});

describe("upstream quota in pickRandomProvider", () => {
  test("records quota_low and quota_exhausted filter reasons with details", async () => {
    quotaMocks.verdicts.set(2, LOW);
    quotaMocks.verdicts.set(3, EXHAUSTED);
    const providers = [provider(1), provider(2), provider(3)];
    const { provider: picked, context } = await resolver.pickRandomProvider(session(providers));
    expect(picked?.id).toBe(1);
    expect(context.filteredProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 2, reason: "quota_low", details: "5h remaining 4% < 10%" }),
        expect.objectContaining({
          id: 3,
          reason: "quota_exhausted",
          details: "upstream_balance_exhausted",
        }),
      ])
    );
  });

  test("labels spend-limited providers as rate_limited even when quota is also low", async () => {
    quotaMocks.verdicts.set(2, LOW);
    rateLimitMocks.RateLimitService.checkTotalCostLimit.mockResolvedValue({
      allowed: false,
      current: 10,
      reason: "limit",
    } as never);
    const limited = provider(2, { limitTotalUsd: 10 } as Partial<Provider>);
    const { context } = await resolver.pickRandomProvider(session([limited]));
    expect(context.filteredProviders).toEqual([
      expect.objectContaining({ id: 2, reason: "rate_limited" }),
    ]);
  });
});

describe("upstream quota in sticky paths", () => {
  test("session reuse keeps a low provider but rejects an exhausted one", async () => {
    const bound = provider(1);
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(1);

    quotaMocks.verdicts.set(1, LOW);
    expect((await resolver.findReusable(session([bound])))?.id).toBe(1);

    quotaMocks.verdicts.set(1, EXHAUSTED);
    expect(await resolver.findReusable(session([bound]))).toBeNull();
  });

  test("prefix affinity keeps low providers only for continuing conversations", async () => {
    const candidate = provider(1);
    quotaMocks.verdicts.set(1, LOW);
    expect((await resolver.validateAffinityCandidate(session([candidate], 3), 1))?.id).toBe(1);
    expect(await resolver.validateAffinityCandidate(session([candidate], 1), 1)).toBeNull();

    quotaMocks.verdicts.set(1, EXHAUSTED);
    expect(await resolver.validateAffinityCandidate(session([candidate], 3), 1)).toBeNull();

    quotaMocks.verdicts.set(1, OK);
    expect((await resolver.validateAffinityCandidate(session([candidate], 1), 1))?.id).toBe(1);
  });
});
