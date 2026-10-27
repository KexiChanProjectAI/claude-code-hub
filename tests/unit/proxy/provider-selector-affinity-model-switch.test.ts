import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

/**
 * Model switch inside one session: affinity must keep preferring the original provider
 * unless it is unavailable or does not support the new model.
 * - Prefix affinity scope no longer contains the model, so the lookup still hits.
 * - Hard validation (providerSupportsModel, circuit, enabled) decides whether to keep it.
 */

const settingsControl = vi.hoisted(() => ({ ignoreClientSessionId: true }));

const storeMocks = vi.hoisted(() => ({
  lookup: vi.fn(async () => null as unknown),
  put: vi.fn(async () => {}),
  tombstone: vi.fn(async () => {}),
}));

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async (_providerId: number) => false),
  getCircuitState: vi.fn(() => "closed"),
}));

const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
    getSessionBindingSnapshot: vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "redis_unavailable",
      capabilityState: "unknown",
      legacyFallbackAllowed: true,
    })),
    isSessionProviderCoolingDown: vi.fn(async () => ({
      status: "ok" as const,
      coolingDown: false,
      legacyFallbackAllowed: false as const,
    })),
  },
}));

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
    checkAndTrackProviderSession: vi.fn(async () => ({
      allowed: true,
      count: 1,
      tracked: true,
      referenced: false,
    })),
  },
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);
vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));
vi.mock("@/lib/session-manager", () => sessionManagerMocks);
vi.mock("@/repository/provider", () => ({
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));
vi.mock("@/lib/rate-limit", () => rateLimitMocks);
vi.mock("@/repository/provider-groups", () => ({
  getGroupCostMultiplier: vi.fn(async () => 1),
}));
vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector-settings-cache", () => ({
  getVerboseProviderErrorCached: vi.fn(async () => false),
}));
vi.mock("@/app/v1/_lib/proxy/affinity/affinity-store", () => ({
  getAffinityStore: () => storeMocks,
}));
vi.mock("@/lib/system-settings/proxy-runtime", () => ({
  getProxyRuntimeSettings: vi.fn(async () => ({
    streamGateMode: "off" as const,
    affinityIgnoreClientSessionId: settingsControl.ignoreClientSessionId,
  })),
  isCacheEffectivenessEnabled: () => false,
}));
vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  const baseEnv = actual.EnvSchema.parse({});
  return {
    ...actual,
    getEnvConfig: () => ({
      ...baseEnv,
      ENABLE_PREFIX_AFFINITY: true,
      ENABLE_CACHE_EFFECTIVENESS: false,
      PREFIX_AFFINITY_WINDOW: 8,
    }),
  };
});

import { ProxyProviderResolver } from "@/app/v1/_lib/proxy/provider-selector";

const BOUND_PROVIDER_ID = 42;
const FALLBACK_PROVIDER_ID = 55;

function makeProvider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider_${id}`,
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    disableSessionReuse: false,
    overwriteResponseModel: false,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    providerVendorId: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    ...overrides,
  } as unknown as Provider;
}

let boundProvider: Provider = makeProvider(BOUND_PROVIDER_ID);

function makeSession(model: string, overrides: Record<string, unknown> = {}): any {
  const chainItems: Array<Record<string, unknown>> = [];
  const session: any = {
    sessionId: "sess_model_switch",
    provider: null,
    affinity: null,
    originalFormat: "claude",
    userAgent: "claude-cli/2.0.0",
    authState: { key: { id: 5, providerGroup: "default" }, user: null },
    request: {
      message: {
        model,
        system: "You are helpful.",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
      },
    },
    getEndpointPolicy: () => ({ kind: "default" }),
    shouldReuseProvider: () => true,
    getMessagesLength: () => 3,
    getOriginalModel: () => model,
    getCurrentModel: () => null,
    setProvider(p: Provider) {
      session.provider = p;
    },
    addProviderToChain: vi.fn((provider: Provider, metadata: Record<string, unknown> = {}) => {
      chainItems.push({ id: provider.id, ...metadata });
    }),
    getProviderChain: vi.fn(() => chainItems),
    setLastSelectionContext: vi.fn((ctx: unknown) => {
      session._ctx = ctx;
    }),
    getLastSelectionContext: vi.fn(() => session._ctx ?? null),
    setGroupCostMultiplier: vi.fn(),
    getProvidersSnapshot: vi.fn(async () => [makeProvider(FALLBACK_PROVIDER_ID), boundProvider]),
    recordProviderSessionRef: vi.fn(),
    setSessionBindingSnapshot: vi.fn(),
    getSessionBindingSnapshot: vi.fn(() => null),
    setSessionIdentityMetadata: vi.fn((metadata: unknown) => {
      session._sessionIdentityMetadata = metadata;
    }),
  };
  return Object.assign(session, overrides);
}

function affinityHitFor(providerId: number) {
  return {
    generation: "1",
    identityFp: "rootfp",
    hint: { providerId, matchedFp: "deepfp", matchedIndex: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsControl.ignoreClientSessionId = true;
  boundProvider = makeProvider(BOUND_PROVIDER_ID);
  storeMocks.lookup.mockResolvedValue(affinityHitFor(BOUND_PROVIDER_ID));
  circuitBreakerMocks.isCircuitOpen.mockResolvedValue(false);
  sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(null);
});

describe("prefix affinity across a model switch", () => {
  test("the same conversation keeps one affinity scope regardless of model", async () => {
    const sonnet = makeSession("claude-sonnet-4-5");
    const opus = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(sonnet);
    await ProxyProviderResolver.ensure(opus);

    expect(sonnet.affinity?.scopeTag).toBeTruthy();
    expect(opus.affinity?.scopeTag).toBe(sonnet.affinity?.scopeTag);
    const [firstScope] = storeMocks.lookup.mock.calls[0] as unknown as [string];
    const [secondScope] = storeMocks.lookup.mock.calls[1] as unknown as [string];
    expect(secondScope).toBe(firstScope);
  });

  test("keeps the original provider after a model switch when it accepts any model", async () => {
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(BOUND_PROVIDER_ID);
    expect(session.affinity?.nominatedProviderId).toBe(BOUND_PROVIDER_ID);
    expect(session.getProviderChain()[0]).toMatchObject({
      id: BOUND_PROVIDER_ID,
      reason: "affinity_hit",
      selectionMethod: "prefix_affinity",
    });
  });

  test("keeps the original provider when its allowlist covers the new model", async () => {
    boundProvider = makeProvider(BOUND_PROVIDER_ID, {
      allowedModels: ["claude-sonnet-4-5", "claude-opus-4-5"],
    });
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(BOUND_PROVIDER_ID);
  });

  test("falls back without a tombstone when the original provider does not support the new model", async () => {
    boundProvider = makeProvider(BOUND_PROVIDER_ID, { allowedModels: ["claude-sonnet-4-5"] });
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(FALLBACK_PROVIDER_ID);
    expect(session.affinity?.nominatedProviderId).toBeNull();
    expect(storeMocks.tombstone).not.toHaveBeenCalled();
  });

  test("falls back when the original provider circuit is open", async () => {
    circuitBreakerMocks.isCircuitOpen.mockImplementation(
      async (providerId: number) => providerId === BOUND_PROVIDER_ID
    );
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(FALLBACK_PROVIDER_ID);
  });

  test("falls back when the original provider is disabled", async () => {
    boundProvider = makeProvider(BOUND_PROVIDER_ID, { isEnabled: false });
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(FALLBACK_PROVIDER_ID);
  });
});

describe("explicit session binding across a model switch", () => {
  beforeEach(() => {
    settingsControl.ignoreClientSessionId = false;
    storeMocks.lookup.mockResolvedValue(null);
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(BOUND_PROVIDER_ID);
  });

  test("reuses the bound provider for a different model", async () => {
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(BOUND_PROVIDER_ID);
    expect(session.getProviderChain()[0]).toMatchObject({ reason: "session_reuse" });
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
  });

  test("clears the binding and reselects when the bound provider rejects the new model", async () => {
    boundProvider = makeProvider(BOUND_PROVIDER_ID, { allowedModels: ["claude-sonnet-4-5"] });
    const session = makeSession("claude-opus-4-5");

    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(FALLBACK_PROVIDER_ID);
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalled();
  });
});
