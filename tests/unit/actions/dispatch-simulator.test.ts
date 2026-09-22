import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));

const vendorCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));

const rateLimitMocks = vi.hoisted(() => ({
  checkCostLimits: vi.fn(async () => ({ allowed: true })),
  checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
  checkTotalCostLimit: vi.fn(async () => ({ allowed: true })),
}));

const endpointSelectorMocks = vi.hoisted(() => ({
  getEndpointFilterStats: vi.fn(async () => ({
    total: 2,
    enabled: 2,
    circuitOpen: 0,
    available: 2,
  })),
}));

const timezoneMocks = vi.hoisted(() => ({
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));

const repositoryMocks = vi.hoisted(() => ({
  findAllProvidersFresh: vi.fn(async () => []),
}));

vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);
vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorCircuitMocks);
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  getAllEndpointHealthStatusAsync: vi.fn(async () => ({})),
}));
vi.mock("@/lib/provider-endpoints/endpoint-selector", () => endpointSelectorMocks);
vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: rateLimitMocks,
}));
vi.mock("@/lib/utils/timezone", () => timezoneMocks);
vi.mock("@/repository/provider", () => repositoryMocks);

function createProvider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider-${id}`,
    url: `https://provider-${id}.example.com`,
    key: `sk-${id}`,
    providerVendorId: id,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: "alpha",
    providerType: "claude",
    preserveClientIp: false,
    disableSessionReuse: false,
    overwriteResponseModel: false,
    modelRedirects: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenDuration: 60_000,
    circuitBreakerHalfOpenSuccessThreshold: 1,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 60_000,
    requestTimeoutNonStreamingMs: 120_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    swapCacheTtlBilling: false,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    codexServiceTierPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: null,
    rpm: null,
    rpd: null,
    cc: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Provider;
}

describe("dispatch simulator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpointSelectorMocks.getEndpointFilterStats.mockResolvedValue({
      total: 2,
      enabled: 2,
      circuitOpen: 0,
      available: 2,
    });
  });

  test("simulates the decision chain and priority tiers end-to-end", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    rateLimitMocks.checkCostLimits.mockImplementation(async (entityId: number) =>
      entityId === 3
        ? { allowed: false, reason: "Provider daily cost limit reached" }
        : { allowed: true }
    );

    const providers: Provider[] = [
      createProvider(1, { name: "group-miss", groupTag: "beta" }),
      createProvider(2, { name: "format-miss", providerType: "openai-compatible" }),
      createProvider(3, {
        name: "rate-limited",
        priority: 1,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
      }),
      createProvider(4, {
        name: "winner",
        priority: 0,
        weight: 3,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
        modelRedirects: [{ matchType: "prefix", source: "claude-opus-", target: "glm-4.6" }],
      }),
      createProvider(5, {
        name: "backup",
        priority: 2,
        weight: 1,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
        providerVendorId: null,
      }),
    ];

    const result = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps.map((step) => step.stepName)).toEqual([
      "groupFilter",
      "formatCompatibility",
      "enabledCheck",
      "activeTime",
      "modelAllowlist",
      "healthAndLimits",
      "priorityTiers",
      "modelRedirect",
      "endpointSummary",
    ]);

    expect(result.steps[0].outputCount).toBe(4);
    expect(result.steps[1].outputCount).toBe(3);
    expect(result.steps[5].outputCount).toBe(2);
    expect(result.steps[7].outputCount).toBe(1);
    expect(result.steps[8].outputCount).toBe(1);
    expect(result.priorityTiers).toHaveLength(2);
    expect(result.selectedPriority).toBe(0);
    expect(result.finalCandidateCount).toBe(1);
    expect(result.priorityTiers[0].providers[0].name).toBe("winner");
    expect(
      result.steps[7].surviving.find((provider) => provider.name === "winner")?.redirectedModel
    ).toBe("glm-4.6");
    expect(
      result.steps[8].surviving.find((provider) => provider.name === "winner")?.endpointStats
    ).toEqual({
      total: 2,
      enabled: 2,
      circuitOpen: 0,
      available: 2,
    });
  });

  test("skips model allowlist filtering for resource-style requests without model", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      [
        createProvider(10, {
          groupTag: "default",
          providerType: "openai-compatible",
          allowedModels: [{ matchType: "exact", pattern: "guarded-model" }],
        }),
      ],
      {
        clientFormat: "openai",
        modelName: "",
        groupTags: [],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps[0].stepName).toBe("groupFilter");
    expect(result.steps[0].outputCount).toBe(1);
    expect(result.steps[4].stepName).toBe("modelAllowlist");
    expect(result.steps[4].note).toBe("model_filter_skipped_for_resource_request");
    expect(result.steps[4].outputCount).toBe(1);
  });

  test("accepts gemini-cli format and keeps gemini-cli providers eligible", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      [
        createProvider(20, {
          groupTag: "default",
          providerType: "gemini-cli",
          allowedModels: [{ matchType: "exact", pattern: "gemini-2.5-pro" }],
        }),
      ],
      {
        clientFormat: "gemini-cli",
        modelName: "",
        groupTags: [],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps[0].stepName).toBe("groupFilter");
    expect(result.steps[0].outputCount).toBe(1);
    expect(result.steps[1].stepName).toBe("formatCompatibility");
    expect(result.steps[1].outputCount).toBe(1);
    expect(result.finalCandidateCount).toBe(1);
  });

  test("server action rejects non-admin callers", async () => {
    const { simulateDispatchAction } = await import("@/actions/dispatch-simulator");

    authMocks.getSession.mockResolvedValue(null);

    const result = await simulateDispatchAction({
      clientFormat: "claude",
      modelName: "claude-opus-4-1",
      groupTags: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PERMISSION_DENIED");
  });
});

describe("dispatch simulator - provider prefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endpointSelectorMocks.getEndpointFilterStats.mockResolvedValue({
      total: 1,
      enabled: 1,
      circuitOpen: 0,
      available: 1,
    });
  });

  function prefixedProviders(): Provider[] {
    return [
      createProvider(40, {
        name: "prefixed",
        groupTag: "default",
        providerType: "openai-compatible",
        providerPrefix: "openai/",
        allowedModels: [{ matchType: "exact", pattern: "gpt-5.6-luna" }],
      }),
      createProvider(41, {
        name: "plain",
        groupTag: "default",
        providerType: "openai-compatible",
      }),
    ];
  }

  test("keeps the prefixed provider and previews the stripped upstream model", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      prefixedProviders(),
      { clientFormat: "openai", modelName: "openai/gpt-5.6-luna", groupTags: [] },
      { systemTimezone: "UTC" }
    );

    const allowlist = result.steps.find((step) => step.stepName === "modelAllowlist");
    expect(allowlist?.surviving.map((provider) => provider.name).sort()).toEqual([
      "plain",
      "prefixed",
    ]);

    const redirect = result.steps.find((step) => step.stepName === "modelRedirect");
    const prefixed = redirect?.surviving.find((provider) => provider.name === "prefixed");
    expect(prefixed?.redirectedModel).toBe("gpt-5.6-luna");
    expect(prefixed?.prefixStripped).toBe(true);
    expect(prefixed?.details).toBe("provider_prefix_stripped");

    const plain = redirect?.surviving.find((provider) => provider.name === "plain");
    expect(plain?.redirectedModel).toBe("openai/gpt-5.6-luna");
    expect(plain?.details).toBe("no_redirect_rule_matched");
    expect(plain && "prefixStripped" in plain).toBe(false);

    const tierProvider = result.priorityTiers[0]?.providers.find(
      (provider) => provider.name === "prefixed"
    );
    expect(tierProvider?.redirectedModel).toBe("gpt-5.6-luna");
  });

  test("filters the prefixed provider out for an unprefixed model with a prefix reason", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      prefixedProviders(),
      { clientFormat: "openai", modelName: "gpt-5.6-luna", groupTags: [] },
      { systemTimezone: "UTC" }
    );

    const allowlist = result.steps.find((step) => step.stepName === "modelAllowlist");
    expect(allowlist?.surviving.map((provider) => provider.name)).toEqual(["plain"]);
    expect(allowlist?.filteredOut[0]?.name).toBe("prefixed");
    expect(allowlist?.filteredOut[0]?.details).toContain("did not match provider prefix openai/");
  });

  test("reports redirect_rule_matched when a bare-name rule applies after the strip", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      [
        createProvider(42, {
          name: "prefixed-redirect",
          groupTag: "default",
          providerType: "openai-compatible",
          providerPrefix: "openai/",
          modelRedirects: [{ matchType: "exact", source: "gpt-5.6-luna", target: "luna-up" }],
        }),
      ],
      { clientFormat: "openai", modelName: "openai/gpt-5.6-luna", groupTags: [] },
      { systemTimezone: "UTC" }
    );

    const redirect = result.steps.find((step) => step.stepName === "modelRedirect");
    expect(redirect?.surviving[0]?.redirectedModel).toBe("luna-up");
    expect(redirect?.surviving[0]?.details).toBe("redirect_rule_matched");
  });
});
