import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());
const findAllProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/repository/provider", () => ({
  createProvider: vi.fn(),
  deleteProvider: vi.fn(),
  findAllProviders: findAllProvidersMock,
  findAllProvidersFresh: vi.fn(async () => []),
  findProviderById: vi.fn(),
  getProviderStatistics: vi.fn(async () => []),
  resetProviderTotalCostResetAt: vi.fn(async () => {}),
  updateProvider: vi.fn(),
  updateProviderPrioritiesBatch: vi.fn(async () => 0),
  updateProvidersBatch: vi.fn(async () => 0),
}));

vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: vi.fn(),
}));

vi.mock("@/lib/redis/circuit-breaker-config", () => ({
  deleteProviderCircuitConfig: vi.fn(),
  saveProviderCircuitConfig: vi.fn(),
}));

vi.mock("@/lib/circuit-breaker", () => ({
  clearConfigCache: vi.fn(),
  clearProviderState: vi.fn(),
  forceCloseCircuitState: vi.fn(),
  getAllHealthStatusAsync: vi.fn(async () => ({})),
  publishCircuitBreakerConfigInvalidation: vi.fn(),
  resetCircuit: vi.fn(),
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    terminateProviderSessionsBatch: vi.fn(async () => 0),
    terminateStickySessionsForProviders: vi.fn(async () => 0),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface ProviderStub {
  isEnabled?: boolean;
  groupTag: string | null;
  providerPrefix?: string | null;
  allowedModels: unknown;
}

function provider(stub: ProviderStub) {
  return { isEnabled: true, providerPrefix: null, ...stub };
}

async function suggest(providerGroup?: string | null) {
  const { getModelSuggestionsByProviderGroup } = await import("@/actions/providers");
  return getModelSuggestionsByProviderGroup(providerGroup);
}

describe("getModelSuggestionsByProviderGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    findAllProvidersMock.mockResolvedValue([]);
  });

  it("returns model ids with the provider prefix applied", async () => {
    findAllProvidersMock.mockResolvedValue([
      provider({ groupTag: "default", providerPrefix: "xai/", allowedModels: ["grok-4.6"] }),
      provider({
        groupTag: "default",
        providerPrefix: "openai/test/",
        allowedModels: [{ matchType: "exact", pattern: "gpt-5.5" }],
      }),
      provider({ groupTag: "default", allowedModels: ["gpt-5.4"] }),
    ]);

    const result = await suggest("default");

    expect(result).toEqual({
      ok: true,
      data: ["gpt-5.4", "openai/test/gpt-5.5", "xai/grok-4.6"],
    });
  });

  it("keeps distinct prefixes apart and dedupes identical prefixed ids", async () => {
    findAllProvidersMock.mockResolvedValue([
      provider({ groupTag: "default", providerPrefix: "zai/", allowedModels: ["glm-5.3"] }),
      provider({ groupTag: "default", providerPrefix: "zai/", allowedModels: ["glm-5.3"] }),
      provider({ groupTag: "default", providerPrefix: "opencode/", allowedModels: ["glm-5.3"] }),
    ]);

    const result = await suggest("default");

    expect(result).toEqual({ ok: true, data: ["opencode/glm-5.3", "zai/glm-5.3"] });
  });

  it("skips non-exact rules that cannot be enumerated", async () => {
    findAllProvidersMock.mockResolvedValue([
      provider({
        groupTag: "default",
        providerPrefix: "m/",
        allowedModels: [
          { matchType: "prefix", pattern: "gpt-" },
          { matchType: "regex", pattern: "^claude-.*$" },
          { matchType: "exact", pattern: "kept" },
          "  ",
        ],
      }),
    ]);

    const result = await suggest("default");

    expect(result).toEqual({ ok: true, data: ["m/kept"] });
  });

  it("filters by group, treating empty input and ungrouped providers as default", async () => {
    findAllProvidersMock.mockResolvedValue([
      provider({ groupTag: null, providerPrefix: "a/", allowedModels: ["ungrouped"] }),
      provider({
        groupTag: "premuim,cn,daily",
        providerPrefix: "opencode/",
        allowedModels: ["mimo-v2.6-flash"],
      }),
      provider({ isEnabled: false, groupTag: "default", allowedModels: ["disabled"] }),
    ]);

    expect(await suggest(null)).toEqual({ ok: true, data: ["a/ungrouped"] });
    expect(await suggest("cn")).toEqual({ ok: true, data: ["opencode/mimo-v2.6-flash"] });
    expect(await suggest("*")).toEqual({
      ok: true,
      data: ["a/ungrouped", "opencode/mimo-v2.6-flash"],
    });
  });

  it("rejects unauthenticated callers", async () => {
    getSessionMock.mockResolvedValue(null);

    const result = await suggest("default");

    expect(result.ok).toBe(false);
    expect(findAllProvidersMock).not.toHaveBeenCalled();
  });
});
