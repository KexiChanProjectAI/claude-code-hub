import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

// ── Mocks (shared by findReusable and pickRandomProvider tests) ──

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);

const vendorTypeCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorTypeCircuitMocks);

const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/session-manager", () => sessionManagerMocks);

const providerRepositoryMocks = vi.hoisted(() => ({
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));

vi.mock("@/repository/provider", () => providerRepositoryMocks);

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
  },
}));

vi.mock("@/lib/rate-limit", () => rateLimitMocks);

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Helpers ──

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "test-provider",
    isEnabled: true,
    providerType: "openai-compatible",
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
    ...overrides,
  } as unknown as Provider;
}

// Module-level helpers shared across describe blocks: lifted from the
// pickRandomProvider describe so the client-restriction tests can reuse them
// without redefining.
function createPickSession(originalFormat: string, providers: Provider[], originalModel: string) {
  return {
    originalFormat,
    authState: null,
    getProvidersSnapshot: async () => providers,
    getOriginalModel: () => originalModel,
    getCurrentModel: () => originalModel,
    clientRequestsContext1m: () => false,
  } as any;
}

async function setupResolverMocks() {
  const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

  vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
    async (...args: unknown[]) => args[0] as Provider[]
  );
  vi.spyOn(ProxyProviderResolver as any, "selectTopPriority").mockImplementation(
    (...args: unknown[]) => args[0] as Provider[]
  );
  vi.spyOn(ProxyProviderResolver as any, "selectOptimal").mockImplementation(
    (...args: unknown[]) => (args[0] as Provider[])[0] ?? null
  );

  return ProxyProviderResolver;
}

// ══════════════════════════════════════════════════════════════════
// providerSupportsModel with provider prefix
// ══════════════════════════════════════════════════════════════════

describe("providerSupportsModel - provider prefix", () => {
  test("prefixed provider only accepts models carrying the prefix", async () => {
    const { providerSupportsModel } = await import("@/app/v1/_lib/proxy/provider-selector");
    const provider = createProvider({ providerPrefix: "openai/" });

    expect(providerSupportsModel(provider, "openai/gpt-5.6-luna")).toBe(true);
    expect(providerSupportsModel(provider, "gpt-5.6-luna")).toBe(false);
    expect(providerSupportsModel(provider, "openai/")).toBe(false);
  });

  test("prefix match is case-insensitive", async () => {
    const { providerSupportsModel } = await import("@/app/v1/_lib/proxy/provider-selector");
    const provider = createProvider({ providerPrefix: "openai/" });

    expect(providerSupportsModel(provider, "OpenAI/gpt-5.6-luna")).toBe(true);
  });

  test("allowlist is matched against the bare model name", async () => {
    const { providerSupportsModel } = await import("@/app/v1/_lib/proxy/provider-selector");
    const provider = createProvider({
      providerPrefix: "openai/",
      allowedModels: [{ matchType: "exact", pattern: "gpt-5.6-luna" }],
    });

    expect(providerSupportsModel(provider, "openai/gpt-5.6-luna")).toBe(true);
    expect(providerSupportsModel(provider, "openai/gpt-4o")).toBe(false);
    expect(providerSupportsModel(provider, "gpt-5.6-luna")).toBe(false);
  });

  test("allowlist entries written with the prefix do not match", async () => {
    const { providerSupportsModel } = await import("@/app/v1/_lib/proxy/provider-selector");
    const provider = createProvider({
      providerPrefix: "openai/",
      allowedModels: [{ matchType: "exact", pattern: "openai/gpt-5.6-luna" }],
    });

    expect(providerSupportsModel(provider, "openai/gpt-5.6-luna")).toBe(false);
  });

  test("providers without a prefix keep the previous behavior", async () => {
    const { providerSupportsModel } = await import("@/app/v1/_lib/proxy/provider-selector");

    expect(providerSupportsModel(createProvider({ providerPrefix: null }), "openai/gpt-5")).toBe(
      true
    );
    expect(providerSupportsModel(createProvider(), "gpt-5")).toBe(true);
  });
});

describe("pickRandomProvider - provider prefix", () => {
  test("selects the prefixed provider for a prefixed model", async () => {
    const Resolver = await setupResolverMocks();
    const prefixed = createProvider({ id: 31, providerPrefix: "openai/" });
    const session = createPickSession("openai", [prefixed], "openai/gpt-5.6-luna");

    const { provider: picked } = await (Resolver as any).pickRandomProvider(session, []);

    expect(picked?.id).toBe(31);
  });

  test("rejects the prefixed provider for an unprefixed model with prefix_mismatch", async () => {
    const Resolver = await setupResolverMocks();
    const prefixed = createProvider({ id: 32, providerPrefix: "openai/" });
    const plain = createProvider({ id: 33, providerPrefix: null });
    const session = createPickSession("openai", [prefixed, plain], "gpt-5.6-luna");

    const { provider: picked, context } = await (Resolver as any).pickRandomProvider(session, []);

    expect(picked?.id).toBe(33);
    const filtered = context.filteredProviders.find((fp: any) => fp.id === 32);
    expect(filtered?.reason).toBe("prefix_mismatch");
    expect(filtered?.details).toContain("openai/");
  });

  test("reports model_not_allowed when the prefix matches but the allowlist does not", async () => {
    const Resolver = await setupResolverMocks();
    const prefixed = createProvider({
      id: 34,
      providerPrefix: "openai/",
      allowedModels: [{ matchType: "exact", pattern: "gpt-5.6-luna" }],
    });
    const session = createPickSession("openai", [prefixed], "openai/gpt-4o");

    const { provider: picked, context } = await (Resolver as any).pickRandomProvider(session, []);

    expect(picked).toBeNull();
    expect(context.filteredProviders.find((fp: any) => fp.id === 34)?.reason).toBe(
      "model_not_allowed"
    );
  });

  test("an unprefixed provider can still serve a prefixed model name", async () => {
    const Resolver = await setupResolverMocks();
    const plain = createProvider({ id: 35, providerPrefix: null });
    const session = createPickSession("openai", [plain], "openai/gpt-5.6-luna");

    const { provider: picked } = await (Resolver as any).pickRandomProvider(session, []);

    expect(picked?.id).toBe(35);
  });
});
