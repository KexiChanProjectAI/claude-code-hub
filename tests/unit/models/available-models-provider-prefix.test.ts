import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

const upstreamResponse = () => ({
  statusCode: 200,
  body: {
    json: async () => ({ object: "list", data: [{ id: "gpt-4" }, { id: "gpt-4o" }] }),
    text: async () => "",
  },
});

const undiciRequestMock = vi.hoisted(() => vi.fn());

const authUser = vi.hoisted(() => ({
  current: {
    id: 1,
    providerGroup: null,
    isEnabled: true,
    expiresAt: null,
    allowedModels: [] as string[],
  },
}));

vi.mock("undici", () => ({ request: undiciRequestMock }));

vi.mock("@/repository/key", () => ({
  validateApiKeyAndGetUser: vi.fn(),
  resolveApiKeyAuthOutcome: vi.fn(),
}));

vi.mock("@/lib/proxy-agent", () => ({ createProxyAgentForProvider: vi.fn() }));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(),
}));

vi.mock("@/lib/utils/provider-schedule", () => ({
  isProviderActiveNow: vi.fn(),
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  checkProviderGroupMatch: vi.fn(),
}));

vi.mock("@/repository/provider", () => ({
  findAllProviders: vi.fn().mockResolvedValue([]),
}));

function createProvider(overrides: Partial<Provider>): Provider {
  return {
    id: 1,
    name: "openai",
    providerType: "openai-compatible",
    url: "https://upstream.example.com",
    key: "upstream-key",
    preserveClientIp: false,
    allowedModels: null,
    providerPrefix: null,
    isEnabled: true,
    activeTimeStart: null,
    activeTimeEnd: null,
    groupTag: null,
    ...overrides,
  } as unknown as Provider;
}

function createContext() {
  return {
    req: {
      path: "/v1/models",
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? "Bearer user-api-key" : undefined,
      query: () => undefined,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as any;
}

async function listModelIds(providers: Provider[]) {
  const { findAllProviders } = await import("@/repository/provider");
  vi.mocked(findAllProviders).mockResolvedValue(providers);
  const { handleAvailableModels } = await import("@/app/v1/_lib/models/available-models");

  const response = await handleAvailableModels(createContext());
  const body = (await response.json()) as { data: Array<{ id: string; owned_by: string }> };
  return body.data;
}

describe("handleAvailableModels - provider prefix", () => {
  // vitest.config enables mockReset, so implementations are installed per test.
  beforeEach(async () => {
    authUser.current = { ...authUser.current, allowedModels: [] };
    undiciRequestMock.mockImplementation(async () => upstreamResponse());

    const { resolveApiKeyAuthOutcome } = await import("@/repository/key");
    vi.mocked(resolveApiKeyAuthOutcome).mockImplementation(
      async () =>
        ({
          ok: true,
          user: authUser.current,
          key: { providerGroup: null, name: "test-key" },
        }) as any
    );
    const { createProxyAgentForProvider } = await import("@/lib/proxy-agent");
    vi.mocked(createProxyAgentForProvider).mockReturnValue(null);
    const { resolveSystemTimezone } = await import("@/lib/utils/timezone");
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
    const { isProviderActiveNow } = await import("@/lib/utils/provider-schedule");
    vi.mocked(isProviderActiveNow).mockReturnValue(true);
    const { checkProviderGroupMatch } = await import("@/app/v1/_lib/proxy/provider-selector");
    vi.mocked(checkProviderGroupMatch).mockReturnValue(true);
  });

  test("prefixes exact allowlist models of a prefixed provider", async () => {
    const data = await listModelIds([
      createProvider({
        providerPrefix: "openai/",
        allowedModels: [
          { matchType: "exact", pattern: "gpt-5.6-luna" },
          { matchType: "prefix", pattern: "gpt-" },
        ],
      }),
    ]);

    expect(undiciRequestMock).not.toHaveBeenCalled();
    expect(data.map((m) => m.id)).toEqual(["openai/gpt-5.6-luna"]);
    expect(data[0]?.owned_by).toBe("openai");
  });

  test("prefixes models fetched from upstream", async () => {
    const data = await listModelIds([createProvider({ providerPrefix: "openai/" })]);

    expect(undiciRequestMock).toHaveBeenCalledTimes(1);
    expect(data.map((m) => m.id).sort()).toEqual(["openai/gpt-4", "openai/gpt-4o"]);
  });

  test("keeps prefixed and plain listings of the same model distinct", async () => {
    const data = await listModelIds([
      createProvider({
        id: 1,
        providerPrefix: "openai/",
        allowedModels: [{ matchType: "exact", pattern: "gpt-4" }],
      }),
      createProvider({
        id: 2,
        name: "plain",
        allowedModels: [{ matchType: "exact", pattern: "gpt-4" }],
      }),
    ]);

    expect(data.map((m) => m.id).sort()).toEqual(["gpt-4", "openai/gpt-4"]);
  });

  test("dedupes providers that share the same prefix and model", async () => {
    const data = await listModelIds([
      createProvider({
        id: 1,
        providerPrefix: "openai/",
        allowedModels: [{ matchType: "exact", pattern: "gpt-4" }],
      }),
      createProvider({
        id: 2,
        name: "second",
        providerPrefix: "openai/",
        allowedModels: [{ matchType: "exact", pattern: "gpt-4" }],
      }),
    ]);

    expect(data.map((m) => m.id)).toEqual(["openai/gpt-4"]);
  });

  test("user-level allowed models filter on the prefixed id", async () => {
    authUser.current = { ...authUser.current, allowedModels: ["openai/gpt-4"] };

    const data = await listModelIds([
      createProvider({
        providerPrefix: "openai/",
        allowedModels: [
          { matchType: "exact", pattern: "gpt-4" },
          { matchType: "exact", pattern: "gpt-4o" },
        ],
      }),
    ]);

    expect(data.map((m) => m.id)).toEqual(["openai/gpt-4"]);
  });
});
