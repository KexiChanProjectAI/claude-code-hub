import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ReasoningEffortOverrideRule } from "@/types/provider";

const getSessionMock = vi.hoisted(() => vi.fn());
const createProviderMock = vi.hoisted(() => vi.fn());
const updateProviderMock = vi.hoisted(() => vi.fn());
const findProviderByIdMock = vi.hoisted(() => vi.fn());
const findAllProvidersFreshMock = vi.hoisted(() => vi.fn());
const updateProvidersBatchMock = vi.hoisted(() => vi.fn());
const publishProviderCacheInvalidationMock = vi.hoisted(() => vi.fn());
const broadcastProviderCacheInvalidationMock = vi.hoisted(() => vi.fn());
const saveProviderCircuitConfigMock = vi.hoisted(() => vi.fn());
const clearConfigCacheMock = vi.hoisted(() => vi.fn());
const clearProviderStateMock = vi.hoisted(() => vi.fn());
const terminateProviderSessionsBatchMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const emitActionAuditMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));
vi.mock("@/repository/provider", () => ({
  createProvider: createProviderMock,
  findAllProvidersFresh: findAllProvidersFreshMock,
  findProviderById: findProviderByIdMock,
  updateProvider: updateProviderMock,
  updateProvidersBatch: updateProvidersBatchMock,
}));
vi.mock("@/lib/cache/provider-cache", () => ({
  broadcastProviderCacheInvalidation: broadcastProviderCacheInvalidationMock,
  publishProviderCacheInvalidation: publishProviderCacheInvalidationMock,
}));
vi.mock("@/lib/redis/circuit-breaker-config", () => ({
  saveProviderCircuitConfig: saveProviderCircuitConfigMock,
}));
vi.mock("@/lib/circuit-breaker", () => ({
  clearConfigCache: clearConfigCacheMock,
  clearProviderState: clearProviderStateMock,
}));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    terminateProviderSessionsBatch: terminateProviderSessionsBatchMock,
    terminateStickySessionsForProviders: terminateProviderSessionsBatchMock,
  },
}));
vi.mock("@/lib/audit/emit", () => ({ emitActionAudit: emitActionAuditMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const rule: ReasoningEffortOverrideRule = {
  when: {
    originalModel: { matchType: "exact", pattern: "gpt-5" },
    originalReasoningEffort: null,
  },
  overrideEffort: "high",
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Codex provider",
    providerType: "codex",
    reasoningEffortOverrideRules: null,
    limit5hResetMode: "rolling",
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    ...overrides,
  };
}

function addInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Codex provider",
    url: "https://api.openai.com",
    key: "sk-test-key",
    provider_type: "codex",
    tpm: null,
    rpm: null,
    rpd: null,
    cc: null,
    ...overrides,
  };
}

describe("provider reasoning effort rule actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    createProviderMock.mockResolvedValue({
      id: 1,
      name: "Codex provider",
      url: "https://api.openai.com",
      isEnabled: true,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerOpenDuration: 1_800_000,
      circuitBreakerHalfOpenSuccessThreshold: 2,
    });
    updateProviderMock.mockResolvedValue(provider());
    findProviderByIdMock.mockResolvedValue(provider());
    findAllProvidersFreshMock.mockResolvedValue([provider()]);
    updateProvidersBatchMock.mockResolvedValue(1);
    publishProviderCacheInvalidationMock.mockResolvedValue(undefined);
    broadcastProviderCacheInvalidationMock.mockResolvedValue(undefined);
    saveProviderCircuitConfigMock.mockResolvedValue(undefined);
    terminateProviderSessionsBatchMock.mockResolvedValue(undefined);
  });

  test("accepts rules through addProvider and persists the snake_case field", async () => {
    const { addProvider } = await import("@/actions/providers");

    const result = await addProvider(
      addInput({ reasoning_effort_override_rules: [rule] }) as Parameters<typeof addProvider>[0]
    );

    expect(result.ok).toBe(true);
    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort_override_rules: [rule] })
    );
  });

  test.each([
    {
      name: "invalid regex",
      rules: [
        {
          when: { originalModel: { matchType: "regex", pattern: "(" } },
          overrideEffort: "high",
        },
      ],
    },
    {
      name: "51st rule",
      rules: Array.from({ length: 51 }, () => rule),
    },
    {
      name: "malformed predicate",
      rules: [{ when: { originalModel: { matchType: "exact" } }, overrideEffort: "high" }],
    },
  ])("rejects $name before repository writes", async ({ rules }) => {
    const { addProvider } = await import("@/actions/providers");

    const result = await addProvider(
      addInput({ reasoning_effort_override_rules: rules }) as Parameters<typeof addProvider>[0]
    );

    expect(result.ok).toBe(false);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported provider targets and mixed legacy writes", async () => {
    const { addProvider } = await import("@/actions/providers");

    const unsupported = await addProvider(
      addInput({
        provider_type: "openai-compatible",
        reasoning_effort_override_rules: [rule],
      }) as Parameters<typeof addProvider>[0]
    );
    const mixed = await addProvider(
      addInput({
        reasoning_effort_override_rules: [rule],
        codex_reasoning_effort_preference: "high",
      }) as Parameters<typeof addProvider>[0]
    );

    expect(unsupported.ok).toBe(false);
    expect(mixed.ok).toBe(false);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  test("rejects legacy-only edits while preserving existing rules", async () => {
    const { editProvider } = await import("@/actions/providers");
    findProviderByIdMock.mockResolvedValue(provider({ reasoningEffortOverrideRules: [rule] }));

    const result = await editProvider(1, {
      codex_reasoning_effort_preference: "low",
    });

    expect(result.ok).toBe(false);
    expect(updateProviderMock).not.toHaveBeenCalled();
    expect(findProviderByIdMock).toHaveBeenCalledWith(1);
  });

  test("maps batch no_change, set, and clear without collapsing empty set", async () => {
    const { prepareProviderBatchApplyUpdates } = await import("@/lib/provider-patch-contract");

    const noChange = prepareProviderBatchApplyUpdates({
      reasoning_effort_override_rules: { no_change: true },
    });
    const setEmpty = prepareProviderBatchApplyUpdates({
      reasoning_effort_override_rules: { set: [] },
    });
    const clear = prepareProviderBatchApplyUpdates({
      reasoning_effort_override_rules: { clear: true },
    });

    expect(noChange).toEqual({ ok: true, data: {} });
    expect(setEmpty).toEqual({ ok: true, data: { reasoning_effort_override_rules: [] } });
    expect(clear).toEqual({ ok: true, data: { reasoning_effort_override_rules: null } });
  });
});
