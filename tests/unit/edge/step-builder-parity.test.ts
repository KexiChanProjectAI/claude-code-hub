import type { Context } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {
    enableBillingHeaderRectifier: true,
    enableClaudeMetadataUserIdInjection: true,
    enableResponseFixer: true,
    responseFixerConfig: null,
  } as Record<string, unknown>,
  updateMessageRequestDetails: vi.fn(async () => {}),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getCachedSystemSettings: vi.fn(async () => mocks.settings),
    isHttp2Enabled: vi.fn(async () => false),
  };
});

vi.mock("@/lib/session-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session-manager")>();
  return {
    ...actual,
    SessionManager: Object.assign(Object.create(actual.SessionManager), {
      storeSessionSpecialSettings: vi.fn(async () => {}),
      storeSessionRequestHeaders: vi.fn(async () => {}),
      storeSessionRequestPhaseSnapshot: vi.fn(async () => {}),
      storeSessionUpstreamRequestMeta: vi.fn(async () => {}),
    }),
  };
});

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({ releaseAgent: vi.fn(), markUnhealthy: vi.fn() })),
}));

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyFinal: vi.fn(async (_session: unknown, _body: unknown, headers: Headers) => {
      headers.delete("content-length");
    }),
  },
}));

import { applyBodyOps } from "@/app/v1/_lib/edge/body-ops";
import type { HeaderPairs } from "@/app/v1/_lib/edge/contract";
import { buildRequestDigest, createEdgeSessionFromDigest } from "@/app/v1/_lib/edge/digest";
import { buildExecutionStep, type EdgeBodyState } from "@/app/v1/_lib/edge/step-builder";
import { detectFormatByEndpoint } from "@/app/v1/_lib/proxy/format-mapper";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { normalizeResponseInput } from "@/app/v1/_lib/proxy/response-input-rectifier";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Key } from "@/types/key";
import type { Provider } from "@/types/provider";
import type { User } from "@/types/user";

type ForwarderInternals = {
  doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
  fetchWithoutAutoDecode: (
    url: string,
    init: RequestInit & { headers: Headers; body: string }
  ) => Promise<Response>;
};

const forwarder = ProxyForwarder as unknown as ForwarderInternals;

const USER = { id: 3, name: "alice" } as unknown as User;
function makeKey(overrides: Partial<Key> = {}): Key {
  return { id: 42, name: "k", key: "sk-client", cacheTtlPreference: null, ...overrides } as Key;
}

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 9,
    name: "anthropic-main",
    url: "https://api.anthropic.example.com",
    key: "sk-upstream",
    providerVendorId: 0,
    isEnabled: true,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 0,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    cacheTtlPreference: null,
    context1mPreference: null,
    customHeaders: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    reasoningEffortOverrideRules: null,
    ...overrides,
  } as unknown as Provider;
}

const CLIENT_HEADERS: HeaderPairs = [
  ["content-type", "application/json"],
  ["anthropic-version", "2023-06-01"],
  ["anthropic-beta", "interleaved-thinking-2025-05-14"],
  ["user-agent", "claude-cli/2.1.90 (external, cli)"],
  ["x-api-key", "sk-client"],
  ["x-stainless-lang", "js"],
];

function makeContext(url: string, body: Record<string, unknown>): Context {
  const request = new Request(url, {
    method: "POST",
    headers: Object.fromEntries(CLIENT_HEADERS),
    body: JSON.stringify(body),
  });
  return {
    req: {
      method: "POST",
      url,
      raw: request,
      header: (name?: string) =>
        name === undefined
          ? Object.fromEntries(request.headers.entries())
          : (request.headers.get(name) ?? undefined),
    },
  } as unknown as Context;
}

function prepare(session: ProxySession, key: Key): void {
  session.setAuthState({ user: USER, key, apiKey: "sk-client", success: true });
  session.setSessionId("sess_parity_1");
}

async function runLocal(
  body: Record<string, unknown>,
  provider: Provider,
  key: Key,
  path = "/v1/messages"
) {
  const session = await ProxySession.fromContext(makeContext(`https://proxy.local${path}`, body));
  // 与 proxy-handler 一致：按端点识别格式，response 格式在守卫链前规范化 input
  const format = detectFormatByEndpoint(path);
  if (format) session.setOriginalFormat(format);
  if (session.originalFormat === "response") await normalizeResponseInput(session);
  prepare(session, key);
  session.setProvider(provider);
  let captured: { url: string; headers: Headers; body: string } | null = null;
  const spy = vi
    .spyOn(forwarder, "fetchWithoutAutoDecode")
    .mockImplementation(async (url, init) => {
      captured = { url, headers: new Headers(init.headers), body: init.body as string };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  try {
    await forwarder.doForward(session, provider, provider.url);
  } finally {
    spy.mockRestore();
  }
  if (!captured) throw new Error("fetch not called");
  return {
    ...(captured as { url: string; headers: Headers; body: string }),
    specialSettings: session.getSpecialSettings(),
  };
}

async function runEdge(
  body: Record<string, unknown>,
  provider: Provider,
  key: Key,
  path = "/v1/messages"
) {
  const text = JSON.stringify(body);
  const digest = buildRequestDigest({
    edgeId: "edge-test",
    edgeRequestId: "r1",
    receivedAtMs: Date.now(),
    method: "POST",
    path,
    headers: CLIENT_HEADERS,
    clientIp: null,
    body,
    bodyBytes: Buffer.byteLength(text),
  });
  const session = createEdgeSessionFromDigest(digest);
  session.setOriginalFormat(digest.format);
  const inputRectified =
    !!digest.responseInputRectify && digest.responseInputRectify.action !== "passthrough";
  if (digest.responseInputRectify && inputRectified) {
    session.addSpecialSetting({
      type: "response_input_rectifier",
      scope: "request",
      hit: true,
      action: digest.responseInputRectify.action,
      originalType: digest.responseInputRectify.originalType,
    });
  }
  prepare(session, key);
  const bodyState: EdgeBodyState = {
    originalTopLevel: structuredClone(digest.topLevel),
    hasPrivateParams: digest.hasPrivateParams,
    contentOps: inputRectified ? [{ op: "normalize_response_input" }] : [],
  };
  const step = await buildExecutionStep({
    session,
    body: bodyState,
    provider,
    endpoint: { endpointId: null, baseUrl: provider.url },
    stepId: "1:1:1",
    attemptNumber: 1,
    totalProvidersAttempted: 1,
    attemptKind: "normal",
    applyProviderOverrides: true,
    delayMs: 0,
    hedge: null,
    heartbeatIntervalMs: 15_000,
  });
  const applied = applyBodyOps(JSON.parse(text), step.bodyOps);
  return { step, body: JSON.stringify(applied.message), session };
}

function comparableHeaders(headers: Headers | HeaderPairs): Array<[string, string]> {
  const entries: Array<[string, string]> =
    headers instanceof Headers ? Array.from(headers.entries()) : [...headers];
  return entries
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .filter(([name]) => name !== "content-length")
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const BASE_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: true,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90" },
    { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
  ],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    },
  ],
};

const RESPONSES_BODY = {
  model: "gpt-5-codex",
  stream: true,
  instructions: "You are Codex.",
  reasoning: { effort: "medium", summary: "auto" },
  text: { verbosity: "medium" },
  parallel_tool_calls: false,
  prompt_cache_key: "pck-1",
  input: [
    { role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
    { type: "function_call_output", call_id: "c1", output: "done", _trace: 1 },
  ],
};

const CHAT_BODY = {
  model: "gpt-4.1",
  stream: true,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
};

const CODEX_PROVIDER: Partial<Provider> = {
  name: "codex-main",
  url: "https://api.openai.example.com/v1",
  providerType: "codex",
  codexReasoningEffortPreference: null,
  codexReasoningSummaryPreference: null,
  codexTextVerbosityPreference: null,
  codexParallelToolCallsPreference: null,
  codexImageGenerationPreference: null,
  codexServiceTierPreference: null,
} as Partial<Provider>;

const CHAT_PROVIDER: Partial<Provider> = {
  name: "openai-compatible",
  url: "https://api.openai.example.com/v1",
  providerType: "openai-compatible",
};

const CASES: Array<{
  name: string;
  body: Record<string, unknown>;
  path?: string;
  provider?: Partial<Provider>;
  key?: Partial<Key>;
}> = [
  { name: "plain request with billing header and metadata injection", body: BASE_BODY },
  {
    name: "key cache TTL 1h rewrites cache_control and anthropic-beta",
    body: BASE_BODY,
    key: { cacheTtlPreference: "1h" },
  },
  {
    name: "provider cache TTL 5m",
    body: BASE_BODY,
    provider: { cacheTtlPreference: "5m" },
  },
  {
    name: "model redirect",
    body: BASE_BODY,
    provider: {
      modelRedirects: [{ matchType: "exact", source: "claude-sonnet-4-5", target: "claude-x" }],
    } as Partial<Provider>,
  },
  {
    name: "anthropic max tokens and thinking budget overrides",
    body: { ...BASE_BODY, max_tokens: 4096 },
    provider: {
      anthropicMaxTokensPreference: "32000",
      anthropicThinkingBudgetPreference: "10240",
    } as Partial<Provider>,
  },
  {
    name: "private parameters are stripped",
    body: {
      ...BASE_BODY,
      _debug: true,
      messages: [{ role: "user", content: "hi", _trace: "x" }],
    },
  },
  {
    name: "existing metadata user id is kept",
    body: { ...BASE_BODY, metadata: { user_id: "user_abc_account__session_def" } },
  },
  {
    name: "claude-auth with custom header templates",
    body: BASE_BODY,
    provider: {
      providerType: "claude-auth",
      customHeaders: { "x-session": "{{session.id}}", "x-ua": "{{header.user-agent}}" },
    } as Partial<Provider>,
  },
  {
    name: "string system prompt that is a billing header",
    body: { ...BASE_BODY, system: "x-anthropic-billing-header: cc_version=1" },
  },
  {
    name: "codex responses passthrough with private params",
    body: RESPONSES_BODY,
    path: "/v1/responses",
    provider: CODEX_PROVIDER,
  },
  {
    name: "codex responses with provider overrides",
    body: { ...RESPONSES_BODY, service_tier: "priority" },
    path: "/v1/responses",
    provider: {
      ...CODEX_PROVIDER,
      codexReasoningEffortPreference: "high",
      codexReasoningSummaryPreference: "detailed",
      codexTextVerbosityPreference: "low",
      codexParallelToolCallsPreference: "true",
      codexServiceTierPreference: "flex",
    } as Partial<Provider>,
  },
  {
    name: "codex responses with a service tier unset rule",
    body: { ...RESPONSES_BODY, service_tier: "priority" },
    path: "/v1/responses",
    provider: {
      ...CODEX_PROVIDER,
      codexServiceTierPreference: "flex",
      serviceTierOverrideRules: [
        { when: { originalServiceTier: "priority" }, overrideServiceTier: null },
      ],
    } as Partial<Provider>,
  },
  {
    name: "codex responses with a conditional service tier rule",
    body: RESPONSES_BODY,
    path: "/v1/responses",
    provider: {
      ...CODEX_PROVIDER,
      serviceTierOverrideRules: [
        {
          when: { originalModel: { matchType: "prefix", pattern: "gpt-5" } },
          overrideServiceTier: "priority",
        },
      ],
    } as Partial<Provider>,
  },
  {
    name: "codex responses with string input normalized",
    body: { model: "gpt-5-codex", stream: false, input: "hello there" },
    path: "/v1/responses",
    provider: CODEX_PROVIDER,
  },
  {
    name: "codex responses with object input and model redirect",
    body: { model: "gpt-5-codex", input: { role: "user", content: "hi" } },
    path: "/v1/responses",
    provider: {
      ...CODEX_PROVIDER,
      modelRedirects: [{ matchType: "exact", source: "gpt-5-codex", target: "gpt-5.1-codex" }],
    } as Partial<Provider>,
  },
  {
    name: "chat completions stream gets include_usage",
    body: CHAT_BODY,
    path: "/v1/chat/completions",
    provider: CHAT_PROVIDER,
  },
  {
    name: "chat completions keeps existing stream_options",
    body: { ...CHAT_BODY, stream_options: { include_obfuscation: false } },
    path: "/v1/chat/completions",
    provider: CHAT_PROVIDER,
  },
  {
    name: "chat completions non-stream is untouched",
    body: { ...CHAT_BODY, stream: false, _meta: 1 },
    path: "/v1/chat/completions",
    provider: CHAT_PROVIDER,
  },
];

describe("edge step builder parity with local forwarder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each(CASES)(
    "$name",
    async ({ body, path, provider: providerOverrides, key: keyOverrides }) => {
      const provider = createProvider(providerOverrides);
      const key = makeKey(keyOverrides);

      const local = await runLocal(structuredClone(body), provider, key, path);
      const edge = await runEdge(structuredClone(body), provider, key, path);

      expect(edge.step.url).toBe(local.url);
      expect(comparableHeaders(edge.step.headers)).toEqual(comparableHeaders(local.headers));
      expect(JSON.parse(edge.body)).toEqual(JSON.parse(local.body));
      expect(edge.body).toBe(local.body);
      // billing header 审计由远端 opResults 回填（handlers.applyOpResults），此处不比较
      const withoutBillingAudit = (settings: unknown) =>
        ((settings as Array<{ type: string }> | null) ?? []).filter(
          (setting) => setting.type !== "billing_header_rectifier"
        );
      expect(withoutBillingAudit(edge.session.getSpecialSettings())).toEqual(
        withoutBillingAudit(local.specialSettings)
      );
    }
  );

  test("step carries client format and forced stream handling for codex", async () => {
    const codex = await runEdge(
      structuredClone(RESPONSES_BODY),
      createProvider(CODEX_PROVIDER),
      makeKey(),
      "/v1/responses"
    );
    expect(codex.step.clientFormat).toBe("response");
    expect(codex.step.provider.type).toBe("codex");
    expect(codex.step.forceStreamHandling).toBe(true);

    const chat = await runEdge(
      structuredClone(CHAT_BODY),
      createProvider(CHAT_PROVIDER),
      makeKey(),
      "/v1/chat/completions"
    );
    expect(chat.step.clientFormat).toBe("openai");
    expect(chat.step.provider.type).toBe("openai-compatible");
    expect(chat.step.forceStreamHandling).toBe(false);
    expect(chat.step.bodyOps).toContainEqual({
      op: "set_top_level",
      key: "stream_options",
      value: { include_usage: true },
    });
  });

  test("a service tier unset rule becomes a delete_top_level op", async () => {
    const result = await runEdge(
      structuredClone({ ...RESPONSES_BODY, service_tier: "priority" }),
      createProvider({
        ...CODEX_PROVIDER,
        serviceTierOverrideRules: [{ when: {}, overrideServiceTier: null }],
      } as Partial<Provider>),
      makeKey(),
      "/v1/responses"
    );
    expect(result.step.bodyOps).toContainEqual({ op: "delete_top_level", key: "service_tier" });
    expect(JSON.parse(result.body)).not.toHaveProperty("service_tier");
  });

  test("provider overrides are only applied on the first attempt", async () => {
    const provider = createProvider({
      anthropicMaxTokensPreference: "32000",
    } as Partial<Provider>);
    const first = await runEdge(structuredClone(BASE_BODY), provider, makeKey());
    expect(first.step.bodyOps).toContainEqual({
      op: "set_top_level",
      key: "max_tokens",
      value: 32000,
    });
  });
});
