import type { AuthSession } from "@/lib/auth";
import { beforeEach, describe, expect, test, vi } from "vitest";

const getProvidersMock = vi.hoisted(() => vi.fn());
const addProviderMock = vi.hoisted(() => vi.fn());
const editProviderMock = vi.hoisted(() => vi.fn());
const batchUpdateProvidersMock = vi.hoisted(() => vi.fn());
const previewProviderBatchPatchMock = vi.hoisted(() => vi.fn());
const validateAuthTokenMock = vi.hoisted(() => vi.fn());

vi.mock("@/actions/providers", () => ({
  addProvider: addProviderMock,
  batchUpdateProviders: batchUpdateProvidersMock,
  editProvider: editProviderMock,
  getProviders: getProvidersMock,
  previewProviderBatchPatch: previewProviderBatchPatchMock,
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, validateAuthToken: validateAuthTokenMock };
});

const { callV1Route } = await import("../test-utils");

const adminSession = {
  user: { id: 1, role: "admin", isEnabled: true },
  key: { id: 1, userId: 1, key: "admin-token", canLoginWebUi: true },
} as AuthSession;

const rules = [
  {
    when: {
      originalModel: { matchType: "prefix", pattern: "gpt-5" },
      originalServiceTier: "priority",
    },
    overrideServiceTier: null,
  },
  { when: {}, overrideServiceTier: "flex" },
];

const codexBody = {
  name: "Codex provider",
  url: "https://api.openai.com",
  key: "sk-test-key",
  provider_type: "codex",
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Codex provider",
    url: "https://api.openai.com",
    maskedKey: "sk-...1234",
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: "default",
    providerType: "codex",
    providerVendorId: 1,
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
    limit5hResetMode: "rolling",
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    firstByteTimeoutStreamingMs: null,
    streamingIdleTimeoutMs: null,
    requestTimeoutNonStreamingMs: null,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: "inherit",
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
    reasoningEffortOverrideRules: null,
    serviceTierOverrideRules: null,
    geminiGoogleSearchPreference: null,
    tpm: null,
    rpm: null,
    rpd: null,
    cc: null,
    createdAt: "2026-07-30",
    updatedAt: "2026-07-30",
    ...overrides,
  };
}

describe("v1 provider service tier rule contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateAuthTokenMock.mockResolvedValue(adminSession);
    getProvidersMock.mockResolvedValue([provider()]);
    addProviderMock.mockResolvedValue({ ok: true, data: { id: 1 } });
    editProviderMock.mockResolvedValue({
      ok: true,
      data: { undoToken: "undo", operationId: "operation" },
    });
    batchUpdateProvidersMock.mockResolvedValue({ ok: true, data: { updatedCount: 1 } });
    previewProviderBatchPatchMock.mockResolvedValue({
      ok: true,
      data: { previewToken: "preview", previewRevision: "revision", rows: [] },
    });
  });

  test("round-trips null, empty and populated service tier rules", async () => {
    getProvidersMock.mockResolvedValue([
      provider({ id: 1, serviceTierOverrideRules: null }),
      provider({ id: 2, serviceTierOverrideRules: [] }),
      provider({ id: 3, serviceTierOverrideRules: rules }),
    ]);

    const { response, json } = await callV1Route({
      method: "GET",
      pathname: "/api/v1/providers",
      authToken: "admin-token",
    });
    const items = (json as { items: Array<Record<string, unknown>> }).items;

    expect(response.status).toBe(200);
    expect(items.map((item) => item.serviceTierOverrideRules)).toEqual([null, [], rules]);
  });

  test("accepts create with an unset target and forwards the rules field", async () => {
    const { response } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers",
      authToken: "admin-token",
      body: { ...codexBody, service_tier_override_rules: rules },
    });

    expect(response.status).toBe(201);
    expect(addProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ service_tier_override_rules: rules })
    );
  });

  test.each([
    {
      name: "empty-string target",
      body: { ...codexBody, service_tier_override_rules: [{ when: {}, overrideServiceTier: "" }] },
    },
    {
      name: "unknown tier",
      body: {
        ...codexBody,
        service_tier_override_rules: [{ when: {}, overrideServiceTier: "turbo" }],
      },
    },
    {
      name: "non-codex provider",
      body: { ...codexBody, provider_type: "claude", service_tier_override_rules: rules },
    },
    {
      name: "new and legacy fields together",
      body: {
        ...codexBody,
        codex_service_tier_preference: "priority",
        service_tier_override_rules: rules,
      },
    },
  ])("rejects $name through the REST schema", async ({ body }) => {
    const { response } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers",
      authToken: "admin-token",
      body,
    });

    expect(response.status).toBe(400);
    expect(addProviderMock).not.toHaveBeenCalled();
  });

  test("rejects a legacy-only update while rules are stored", async () => {
    getProvidersMock.mockResolvedValue([provider({ serviceTierOverrideRules: rules })]);

    const { response } = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/providers/1",
      authToken: "admin-token",
      body: { codex_service_tier_preference: "priority" },
    });

    expect(response.status).toBe(400);
    expect(editProviderMock).not.toHaveBeenCalled();
  });

  test("rejects co-emission on update even without provider_type", async () => {
    const { response } = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/providers/1",
      authToken: "admin-token",
      body: { codex_service_tier_preference: "priority", service_tier_override_rules: rules },
    });

    expect(response.status).toBe(400);
    expect(editProviderMock).not.toHaveBeenCalled();
  });

  test("forwards an update that clears rules back to the legacy fallback", async () => {
    getProvidersMock.mockResolvedValue([provider({ serviceTierOverrideRules: rules })]);

    const { response } = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/providers/1",
      authToken: "admin-token",
      body: { service_tier_override_rules: null },
    });

    expect(response.status).toBe(200);
    expect(editProviderMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ service_tier_override_rules: null })
    );
  });

  test("forwards direct batch set and clear, and rejects non-codex targets", async () => {
    const setResponse = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchUpdate",
      authToken: "admin-token",
      body: { providerIds: [1], updates: { service_tier_override_rules: rules } },
    });
    const clearResponse = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchUpdate",
      authToken: "admin-token",
      body: { providerIds: [1], updates: { service_tier_override_rules: null } },
    });
    expect(setResponse.response.status).toBe(200);
    expect(clearResponse.response.status).toBe(200);
    expect(batchUpdateProvidersMock).toHaveBeenCalledTimes(2);

    getProvidersMock.mockResolvedValue([provider({ providerType: "claude" })]);
    const rejected = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchUpdate",
      authToken: "admin-token",
      body: { providerIds: [1], updates: { service_tier_override_rules: rules } },
    });
    expect(rejected.response.status).toBe(400);
    expect(batchUpdateProvidersMock).toHaveBeenCalledTimes(2);
  });

  test("forwards batch patch modes and skips non-codex providers", async () => {
    getProvidersMock.mockResolvedValue([
      provider({ id: 1 }),
      provider({ id: 2, providerType: "claude" }),
    ]);
    for (const mode of [{ no_change: true }, { set: rules }, { clear: true }]) {
      const { response } = await callV1Route({
        method: "POST",
        pathname: "/api/v1/providers:batchPatch:preview",
        authToken: "admin-token",
        body: { providerIds: [1, 2], patch: { service_tier_override_rules: mode } },
      });
      expect(response.status).toBe(200);
    }

    expect(previewProviderBatchPatchMock).toHaveBeenCalledTimes(3);
  });

  test("rejects a batch legacy patch for codex providers that have rules", async () => {
    getProvidersMock.mockResolvedValue([provider({ serviceTierOverrideRules: rules })]);
    const { response } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchPatch:preview",
      authToken: "admin-token",
      body: { providerIds: [1], patch: { codex_service_tier_preference: { set: "priority" } } },
    });

    expect(response.status).toBe(400);
    expect(previewProviderBatchPatchMock).not.toHaveBeenCalled();
  });
});
