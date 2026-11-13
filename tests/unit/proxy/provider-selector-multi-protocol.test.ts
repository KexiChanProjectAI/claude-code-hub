import { beforeEach, describe, expect, test, vi } from "vitest";
import { expandProviders } from "@/lib/provider-protocols/expand";
import type { Provider } from "@/types/provider";

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);

const repositoryMocks = vi.hoisted(() => ({
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));

vi.mock("@/repository/provider", () => repositoryMocks);

function createProvider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider-${id}`,
    url: "https://up.example.com/v1",
    isEnabled: true,
    providerType: "claude",
    providerVendorId: 1,
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    allowedModels: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    ...overrides,
  } as unknown as Provider;
}

function createSessionStub(originalFormat: string, snapshot: Provider[], model = "m-1") {
  return {
    originalFormat,
    authState: null,
    getProvidersSnapshot: async () => snapshot,
    getOriginalModel: () => model,
    getCurrentModel: () => model,
    clientRequestsContext1m: () => false,
  } as any;
}

async function setupResolver() {
  const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
  vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
    async (...args: unknown[]) => args[0] as Provider[]
  );
  vi.spyOn(ProxyProviderResolver as any, "selectTopPriority").mockImplementation(
    (...args: unknown[]) => args[0] as Provider[]
  );
  const selectOptimal = vi
    .spyOn(ProxyProviderResolver as any, "selectOptimal")
    .mockImplementation((...args: unknown[]) => (args[0] as Provider[])[0] ?? null);
  return { ProxyProviderResolver, selectOptimal };
}

const multiRow = createProvider(1, {
  providerType: "claude-auth",
  protocols: ["claude", "openai", "response"],
  protocolUrls: { response: "https://responses.example.com" },
});

describe("ProxyProviderResolver with multi-protocol providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    ["claude", "claude-auth", "https://up.example.com/v1"],
    ["openai", "openai-compatible", "https://up.example.com/v1"],
    ["response", "codex", "https://responses.example.com"],
  ])("format %s selects the %s instance of the same row", async (format, type, url) => {
    const { ProxyProviderResolver } = await setupResolver();
    const session = createSessionStub(format, expandProviders([multiRow]));

    const { provider, context } = await (ProxyProviderResolver as any).pickRandomProvider(
      session,
      []
    );

    expect(provider?.id).toBe(1);
    expect(provider?.providerType).toBe(type);
    expect(provider?.url).toBe(url);
    expect(context.totalProviders).toBe(1);
    expect(context.filteredProviders).toEqual([]);
  });

  test("candidate list holds one instance per id so weights are not multiplied", async () => {
    const { ProxyProviderResolver, selectOptimal } = await setupResolver();
    const other = createProvider(2, { providerType: "openai-compatible" });
    const session = createSessionStub("openai", expandProviders([multiRow, other]));

    await (ProxyProviderResolver as any).pickRandomProvider(session, []);

    const candidates = selectOptimal.mock.calls[0][0] as Provider[];
    expect(candidates.map((p) => `${p.id}:${p.providerType}`)).toEqual([
      "1:openai-compatible",
      "2:openai-compatible",
    ]);
  });

  test("a row not serving the format is reported once as a format mismatch", async () => {
    const { ProxyProviderResolver } = await setupResolver();
    const claudeOnly = createProvider(3, { providerType: "claude", protocols: ["claude"] });
    const session = createSessionStub("response", expandProviders([claudeOnly, multiRow]));

    const { provider, context } = await (ProxyProviderResolver as any).pickRandomProvider(
      session,
      []
    );

    expect(provider?.id).toBe(1);
    expect(provider?.providerType).toBe("codex");
    const mismatches = context.filteredProviders.filter(
      (fp: any) => fp.reason === "format_type_mismatch"
    );
    expect(mismatches.map((fp: any) => fp.id)).toEqual([3]);
  });

  test("excluded ids drop every protocol instance of the row", async () => {
    const { ProxyProviderResolver } = await setupResolver();
    const session = createSessionStub("openai", expandProviders([multiRow]));

    const { provider } = await (ProxyProviderResolver as any).pickRandomProvider(session, [1]);

    expect(provider).toBeNull();
  });

  test("without a session the cached provider rows are expanded", async () => {
    const { ProxyProviderResolver } = await setupResolver();
    repositoryMocks.findAllProviders.mockResolvedValueOnce([multiRow]);

    const { provider } = await (ProxyProviderResolver as any).pickRandomProvider(undefined, []);

    expect(provider?.id).toBe(1);
    expect(provider?.providerType).toBe("claude-auth");
  });

  test("findProviderInSnapshot resolves the instance for the session protocol", async () => {
    const { ProxyProviderResolver } = await setupResolver();
    const session = createSessionStub("response", expandProviders([multiRow]));

    const provider = await (ProxyProviderResolver as any).findProviderInSnapshot(session, 1);

    expect(provider?.providerType).toBe("codex");
    expect(provider?.url).toBe("https://responses.example.com");
    expect(await (ProxyProviderResolver as any).findProviderInSnapshot(session, 404)).toBeNull();
  });

  test("selectProviderByType finds a row serving the type through an extra protocol", async () => {
    const { ProxyProviderResolver } = await setupResolver();
    repositoryMocks.findAllProviders.mockResolvedValue([
      createProvider(5, { providerType: "claude", protocols: ["claude", "response"] }),
    ]);

    const { provider } = await ProxyProviderResolver.selectProviderByType(null, "codex");

    expect(provider?.id).toBe(5);
    expect(provider?.providerType).toBe("codex");
  });
});
