/**
 * Provider prefix handling in ModelRedirector: the prefix is stripped before redirect rules
 * run, and the bare model is what reaches the upstream.
 */

import { describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ModelRedirector } from "@/app/v1/_lib/proxy/model-redirector";
import type { OpenAIImageRequestMetadata } from "@/app/v1/_lib/proxy/openai-image-compat";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "p1",
    url: "https://provider.example.com",
    key: "k",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
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
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 100,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
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
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createSession(
  initialModel: string,
  options: { url?: string; imageRequestMetadata?: OpenAIImageRequestMetadata } = {}
): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);
  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(options.url ?? "https://example.com/v1/messages"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: initialModel,
      log: "(test)",
      message: {
        model: initialModel,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      ...(options.imageRequestMetadata
        ? { imageRequestMetadata: options.imageRequestMetadata }
        : {}),
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: "sess-fallback-test",
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    endpointPolicy: resolveEndpointPolicy("/v1/messages"),
    isHeaderModified: () => false,
  });
  return session as ProxySession;
}

describe("ModelRedirector - provider prefix", () => {
  const PREFIXED_MODEL = "openai/gpt-5.6-luna";
  const BARE_MODEL = "gpt-5.6-luna";

  test("strips the prefix from body, buffer, and note without redirect rules", () => {
    const provider = createProvider({ id: 10, providerPrefix: "openai/" });
    const session = createSession(PREFIXED_MODEL);
    session.setProvider(provider);
    session.addProviderToChain(provider, { reason: "initial_selection" });

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe(BARE_MODEL);
    expect(session.request.message.model).toBe(BARE_MODEL);
    expect(session.getOriginalModel()).toBe(PREFIXED_MODEL);
    expect(session.isModelRedirected()).toBe(true);

    const body = JSON.parse(new TextDecoder().decode(session.request.buffer as ArrayBuffer));
    expect(body.model).toBe(BARE_MODEL);
    expect(session.request.note).toContain("Provider Prefix Stripped");

    const redirect = session.getCurrentModelRedirect(10);
    expect(redirect).toEqual({
      originalModel: PREFIXED_MODEL,
      redirectedModel: BARE_MODEL,
      billingModel: PREFIXED_MODEL,
      providerPrefix: "openai/",
    });
    expect(redirect?.matchedRule).toBeUndefined();
    expect(session.getProviderChain().at(-1)?.modelRedirect?.redirectedModel).toBe(BARE_MODEL);
  });

  test("strips the prefix case-insensitively and keeps the remainder case", () => {
    const provider = createProvider({ providerPrefix: "openai/" });
    const session = createSession("OpenAI/GPT-5.6-Luna");

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe("GPT-5.6-Luna");
  });

  test("chains redirect rules written against the bare name", () => {
    const provider = createProvider({
      id: 11,
      providerPrefix: "openai/",
      modelRedirects: [{ matchType: "exact", source: BARE_MODEL, target: "luna-upstream" }],
    });
    const session = createSession(PREFIXED_MODEL);

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe("luna-upstream");
    expect(session.request.note).toContain("Model Redirected");
    const redirect = session.getCurrentModelRedirect(11);
    expect(redirect?.matchedRule?.source).toBe(BARE_MODEL);
    expect(redirect?.providerPrefix).toBe("openai/");
  });

  test("does nothing for a prefixed provider when the model lacks the prefix", () => {
    const provider = createProvider({ providerPrefix: "openai/" });
    const session = createSession(BARE_MODEL);

    expect(ModelRedirector.apply(session, provider)).toBe(false);
    expect(session.request.model).toBe(BARE_MODEL);
  });

  test("resets to the prefixed original when falling back to a provider without prefix", () => {
    const providerA = createProvider({ id: 100, name: "A", providerPrefix: "openai/" });
    const providerB = createProvider({ id: 200, name: "B", providerPrefix: null });
    const session = createSession(PREFIXED_MODEL);

    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe(BARE_MODEL);

    expect(ModelRedirector.apply(session, providerB)).toBe(false);
    expect(session.request.model).toBe(PREFIXED_MODEL);
    expect(session.request.message.model).toBe(PREFIXED_MODEL);
    expect(session.getCurrentModelRedirect(200)).toBeUndefined();
  });

  test("re-strips from the original model on fallback between prefixed providers", () => {
    const providerA = createProvider({
      id: 100,
      providerPrefix: "openai/",
      modelRedirects: [{ matchType: "exact", source: BARE_MODEL, target: "a-target" }],
    });
    const providerB = createProvider({ id: 200, providerPrefix: "OPENAI/" });
    const session = createSession(PREFIXED_MODEL);

    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe("a-target");

    expect(ModelRedirector.apply(session, providerB)).toBe(true);
    expect(session.request.model).toBe(BARE_MODEL);
  });

  test("rewrites and restores a Gemini URL path whose model contains a slash", () => {
    const providerA = createProvider({
      id: 100,
      providerType: "gemini",
      providerPrefix: "google/",
    });
    const providerB = createProvider({ id: 200, providerType: "gemini", providerPrefix: null });
    const session = createSession("google/gemini-2.5-flash", {
      url: "https://example.com/v1beta/models/google/gemini-2.5-flash:generateContent",
    });

    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(session.request.model).toBe("gemini-2.5-flash");

    expect(ModelRedirector.apply(session, providerB)).toBe(false);
    expect(session.requestUrl.pathname).toBe(
      "/v1beta/models/google/gemini-2.5-flash:generateContent"
    );
  });

  test("writes the bare model into the OpenAI image multipart sidecar", () => {
    const metadata: OpenAIImageRequestMetadata = {
      endpoint: "generations",
      bodyKind: "multipart",
      contentType: "multipart/form-data; boundary=x",
      model: "openai/gpt-image-1",
      parts: [
        { kind: "text", name: "model", value: "openai/gpt-image-1" },
        { kind: "text", name: "prompt", value: "a cat" },
      ],
    };
    const provider = createProvider({
      providerType: "openai-compatible",
      providerPrefix: "openai/",
    });
    const session = createSession("openai/gpt-image-1", { imageRequestMetadata: metadata });

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    const sidecar = session.getOpenAIImageRequestMetadata();
    expect(sidecar?.model).toBe("gpt-image-1");
    expect(sidecar?.parts.find((part) => part.name === "model")?.value).toBe("gpt-image-1");
  });

  test("static helpers reflect the prefix strip", () => {
    const provider = createProvider({ providerPrefix: "openai/" });

    expect(ModelRedirector.getRedirectedModel(PREFIXED_MODEL, provider)).toBe(BARE_MODEL);
    expect(ModelRedirector.hasRedirect(PREFIXED_MODEL, provider)).toBe(true);
    expect(ModelRedirector.hasRedirect(BARE_MODEL, provider)).toBe(false);
  });
});

describe("ModelRedirector - unchanged behavior without a provider prefix", () => {
  const RULE = { matchType: "exact" as const, source: "claude-opus-4-1", target: "glm-4.6" };

  test.each([null, ""])("providerPrefix %j behaves like before for matched rules", (prefix) => {
    const provider = createProvider({ id: 7, providerPrefix: prefix, modelRedirects: [RULE] });
    const session = createSession("claude-opus-4-1");

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe("glm-4.6");
    expect(session.request.note).toContain("[Model Redirected: claude-opus-4-1 → glm-4.6]");
    expect(session.getCurrentModelRedirect(7)).toEqual({
      originalModel: "claude-opus-4-1",
      redirectedModel: "glm-4.6",
      billingModel: "claude-opus-4-1",
      matchedRule: RULE,
    });
  });

  test("an identity redirect rule still records a redirect", () => {
    const provider = createProvider({
      id: 8,
      modelRedirects: [{ matchType: "exact", source: "gpt-4o", target: "gpt-4o" }],
    });
    const session = createSession("gpt-4o");

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.getCurrentModelRedirect(8)?.matchedRule?.target).toBe("gpt-4o");
  });

  test("a slash model name is passed through untouched without rules", () => {
    const provider = createProvider({ providerPrefix: null });
    const session = createSession("openai/gpt-5");

    expect(ModelRedirector.apply(session, provider)).toBe(false);
    expect(session.request.model).toBe("openai/gpt-5");
    expect(session.request.note ?? "").not.toContain("Redirected");
  });

  test("without a model, a provider with rules keeps the current redirect snapshot", () => {
    const provider = createProvider({ id: 9, modelRedirects: [RULE] });
    const session = createSession("claude-opus-4-1");
    session.setCurrentModelRedirect(9, {
      originalModel: "x",
      redirectedModel: "y",
      billingModel: "x",
    });
    session.request.model = null as unknown as string;

    expect(ModelRedirector.apply(session, provider)).toBe(false);
    expect(session.getCurrentModelRedirect(9)).toBeDefined();
  });

  test("without a model, a provider without rules clears the redirect snapshot", () => {
    const provider = createProvider({ id: 9, modelRedirects: null });
    const session = createSession("claude-opus-4-1");
    session.setCurrentModelRedirect(9, {
      originalModel: "x",
      redirectedModel: "y",
      billingModel: "x",
    });
    session.request.model = null as unknown as string;

    expect(ModelRedirector.apply(session, provider)).toBe(false);
    expect(session.getCurrentModelRedirect(9)).toBeUndefined();
  });

  test("Gemini URL paths with a slash model segment are not rewritten without a prefix", () => {
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "google", target: "gemini-2.5-pro" }],
    });
    const session = createSession("google", {
      url: "https://example.com/v1beta/models/google/gemini-2.5-flash:generateContent",
    });

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.requestUrl.pathname).toBe(
      "/v1beta/models/google/gemini-2.5-flash:generateContent"
    );
  });

  test("Gemini URL paths without a slash are rewritten exactly as before", () => {
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [
        { matchType: "exact", source: "gemini-2.5-flash", target: "gemini-2.5-pro" },
      ],
    });
    const session = createSession("gemini-2.5-flash", {
      url: "https://example.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    });

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  });
});
