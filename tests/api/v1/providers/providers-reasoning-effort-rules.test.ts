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
      originalModel: { matchType: "exact", pattern: "gpt-5" },
      originalReasoningEffort: null,
    },
    overrideEffort: "high",
  },
];

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

describe("v1 provider reasoning effort rule contract", () => {
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

  test("round-trips null, empty, populated, and explicit-null effort rules", async () => {
    getProvidersMock.mockResolvedValue([
      provider({ id: 1, reasoningEffortOverrideRules: null }),
      provider({ id: 2, reasoningEffortOverrideRules: [] }),
      provider({ id: 3, reasoningEffortOverrideRules: rules }),
    ]);

    const { response, json } = await callV1Route({
      method: "GET",
      pathname: "/api/v1/providers",
      authToken: "admin-token",
    });
    const items = (json as { items: Array<Record<string, unknown>> }).items;

    expect(response.status).toBe(200);
    expect(items.map((item) => item.reasoningEffortOverrideRules)).toEqual([null, [], rules]);
  });

  test("accepts create and forwards the validated rules field", async () => {
    const { response } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers",
      authToken: "admin-token",
      body: {
        name: "Codex provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "codex",
        reasoning_effort_override_rules: rules,
      },
    });

    expect(response.status).toBe(201);
    expect(addProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort_override_rules: rules })
    );
  });

  test.each([
    {
      name: "invalid regex",
      body: {
        name: "Codex provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "codex",
        reasoning_effort_override_rules: [
          {
            when: { originalModel: { matchType: "regex", pattern: "(" } },
            overrideEffort: "high",
          },
        ],
      },
    },
    {
      name: "51st rule",
      body: {
        name: "Codex provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "codex",
        reasoning_effort_override_rules: Array.from({ length: 51 }, () => rules[0]),
      },
    },
    {
      name: "malformed predicate",
      body: {
        name: "Codex provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "codex",
        reasoning_effort_override_rules: [
          { when: { originalModel: { matchType: "exact" } }, overrideEffort: "high" },
        ],
      },
    },
    {
      name: "unsupported provider target vocabulary",
      body: {
        name: "OpenAI provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "openai-compatible",
        reasoning_effort_override_rules: rules,
      },
    },
    {
      name: "new and legacy fields together",
      body: {
        name: "Codex provider",
        url: "https://api.openai.com",
        key: "sk-test-key",
        provider_type: "codex",
        codex_reasoning_effort_preference: "low",
        reasoning_effort_override_rules: rules,
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

  test("rejects legacy-only update while preserving the stored rules", async () => {
    getProvidersMock.mockResolvedValue([provider({ reasoningEffortOverrideRules: rules })]);

    const { response } = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/providers/1",
      authToken: "admin-token",
      body: { codex_reasoning_effort_preference: "low" },
    });

    expect(response.status).toBe(400);
    expect(editProviderMock).not.toHaveBeenCalled();
    const { json } = await callV1Route({
      method: "GET",
      pathname: "/api/v1/providers/1",
      authToken: "admin-token",
    });
    expect((json as Record<string, unknown>).reasoningEffortOverrideRules).toEqual(rules);
  });

  test("forwards direct batch set and clear states", async () => {
    const setResponse = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchUpdate",
      authToken: "admin-token",
      body: { providerIds: [1], updates: { reasoning_effort_override_rules: [] } },
    });
    const clearResponse = await callV1Route({
      method: "POST",
      pathname: "/api/v1/providers:batchUpdate",
      authToken: "admin-token",
      body: { providerIds: [1], updates: { reasoning_effort_override_rules: null } },
    });

    expect(setResponse.response.status).toBe(200);
    expect(clearResponse.response.status).toBe(200);
    expect(batchUpdateProvidersMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ updates: { reasoning_effort_override_rules: [] } })
    );
    expect(batchUpdateProvidersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ updates: { reasoning_effort_override_rules: null } })
    );
  });

  test("forwards batch patch no_change, set, and clear modes", async () => {
    for (const mode of [{ no_change: true }, { set: [] }, { clear: true }]) {
      const { response } = await callV1Route({
        method: "POST",
        pathname: "/api/v1/providers:batchPatch:preview",
        authToken: "admin-token",
        body: { providerIds: [1], patch: { reasoning_effort_override_rules: mode } },
      });
      expect(response.status).toBe(200);
    }

    expect(previewProviderBatchPatchMock).toHaveBeenCalledTimes(3);
  });
});
