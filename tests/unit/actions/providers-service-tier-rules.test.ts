import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ServiceTierOverrideRule } from "@/types/provider";

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

const rule: ServiceTierOverrideRule = {
  when: {
    originalModel: { matchType: "prefix", pattern: "gpt-5" },
    originalServiceTier: "priority",
  },
  overrideServiceTier: null,
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Codex provider",
    providerType: "codex",
    reasoningEffortOverrideRules: null,
    serviceTierOverrideRules: null,
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

describe("provider service tier rule actions", () => {
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

  test("accepts rules (including a null unset target) through addProvider", async () => {
    const { addProvider } = await import("@/actions/providers");

    const result = await addProvider(
      addInput({ service_tier_override_rules: [rule] }) as Parameters<typeof addProvider>[0]
    );

    expect(result.ok).toBe(true);
    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ service_tier_override_rules: [rule] })
    );
  });

  test.each([
    { name: "empty-string target", rules: [{ when: {}, overrideServiceTier: "" }] },
    { name: "unknown tier", rules: [{ when: {}, overrideServiceTier: "turbo" }] },
    {
      name: "invalid regex",
      rules: [
        {
          when: { originalModel: { matchType: "regex", pattern: "(" } },
          overrideServiceTier: null,
        },
      ],
    },
    { name: "51st rule", rules: Array.from({ length: 51 }, () => rule) },
  ])("rejects $name before repository writes", async ({ rules }) => {
    const { addProvider } = await import("@/actions/providers");

    const result = await addProvider(
      addInput({ service_tier_override_rules: rules }) as Parameters<typeof addProvider>[0]
    );

    expect(result.ok).toBe(false);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  test("rejects non-codex providers and mixed legacy writes", async () => {
    const { addProvider } = await import("@/actions/providers");

    const unsupported = await addProvider(
      addInput({ provider_type: "claude", service_tier_override_rules: [rule] }) as Parameters<
        typeof addProvider
      >[0]
    );
    const mixed = await addProvider(
      addInput({
        service_tier_override_rules: [rule],
        codex_service_tier_preference: "priority",
      }) as Parameters<typeof addProvider>[0]
    );

    expect(unsupported.ok).toBe(false);
    expect(mixed.ok).toBe(false);
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  test("rejects legacy-only edits while rules exist, and accepts clearing rules", async () => {
    const { editProvider } = await import("@/actions/providers");
    findProviderByIdMock.mockResolvedValue(provider({ serviceTierOverrideRules: [rule] }));

    const legacy = await editProvider(1, { codex_service_tier_preference: "flex" });
    expect(legacy.ok).toBe(false);
    expect(updateProviderMock).not.toHaveBeenCalled();

    const cleared = await editProvider(1, { service_tier_override_rules: null });
    expect(cleared.ok).toBe(true);
    expect(updateProviderMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ service_tier_override_rules: null })
    );
  });

  test("batchUpdateProviders validates and persists rules", async () => {
    const { batchUpdateProviders } = await import("@/actions/providers");

    const ok = await batchUpdateProviders({
      providerIds: [1],
      updates: { service_tier_override_rules: [rule] },
    });
    expect(ok.ok).toBe(true);
    expect(updateProvidersBatchMock).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ serviceTierOverrideRules: [rule] })
    );

    findAllProvidersFreshMock.mockResolvedValue([provider({ providerType: "claude" })]);
    const rejected = await batchUpdateProviders({
      providerIds: [1],
      updates: { service_tier_override_rules: [rule] },
    });
    expect(rejected.ok).toBe(false);
  });

  test("maps batch no_change, set, and clear without collapsing empty set", async () => {
    const { prepareProviderBatchApplyUpdates } = await import("@/lib/provider-patch-contract");

    expect(
      prepareProviderBatchApplyUpdates({ service_tier_override_rules: { no_change: true } })
    ).toEqual({
      ok: true,
      data: {},
    });
    expect(prepareProviderBatchApplyUpdates({ service_tier_override_rules: { set: [] } })).toEqual({
      ok: true,
      data: { service_tier_override_rules: [] },
    });
    expect(
      prepareProviderBatchApplyUpdates({ service_tier_override_rules: { clear: true } })
    ).toEqual({
      ok: true,
      data: { service_tier_override_rules: null },
    });
  });
});
