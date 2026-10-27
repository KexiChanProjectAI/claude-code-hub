import { describe, expect, test, vi } from "vitest";
import {
  collectCyberRiskErrorTexts,
  detectCyberRiskFallbackTrigger,
  resolveCyberRiskFallback,
} from "@/app/v1/_lib/proxy/cyber-risk-fallback-rectifier";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ModelRedirector } from "@/app/v1/_lib/proxy/model-redirector";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider, ProviderModelRedirectRule } from "@/types/provider";

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

const CYBER_MESSAGE =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 35,
    name: "daily-luna",
    providerType: "codex",
    modelRedirects: null,
    providerPrefix: null,
    cyberRiskFallbackRules: null,
    ...overrides,
  } as Provider;
}

function createSession(model: string, url = "https://example.com/v1/responses"): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);
  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(url),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "{}",
    request: {
      model,
      log: "(test)",
      message: { model, stream: true, input: "hi" },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "u",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "response",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    currentModelRedirect: null,
    cyberRiskFallback: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    endpointPolicy: resolveEndpointPolicy(new URL(url).pathname),
    isHeaderModified: () => false,
  });
  return session as ProxySession;
}

function decodeBody(session: ProxySession): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(session.request.buffer as ArrayBuffer));
}

describe("detectCyberRiskFallbackTrigger", () => {
  test("detects a fake-200 OpenAI response.failed error", () => {
    const error = new ProxyError("FAKE_200_OPENAI_RESPONSE_FAILED", 400, {
      body: `${CYBER_MESSAGE.slice(0, 120)}…`,
      providerId: 35,
      providerName: "daily-luna",
      rawBody: JSON.stringify({
        type: "response.failed",
        response: { status: "failed", error: { code: "cyber_policy", message: CYBER_MESSAGE } },
      }),
      isSyntheticFake200: true,
    });
    expect(detectCyberRiskFallbackTrigger(error)).toBe("flagged for possible cybersecurity risk");
  });

  test("detects from rawBody only when the short body is truncated", () => {
    const error = new ProxyError("FAKE_200_JSON_ERROR_NON_EMPTY", 400, {
      body: "Upstream failed",
      providerId: 1,
      providerName: "p",
      rawBody: '{"error":{"code":"cyber_policy"}}',
    });
    expect(detectCyberRiskFallbackTrigger(error)).toBe("cyber_policy");
  });

  test("detects from the detailed error message argument", () => {
    expect(detectCyberRiskFallbackTrigger(new Error("boom"), `Upstream: ${CYBER_MESSAGE}`)).toBe(
      "flagged for possible cybersecurity risk"
    );
  });

  test("detects from a plain error message", () => {
    expect(detectCyberRiskFallbackTrigger(new Error(CYBER_MESSAGE))).toBe(
      "flagged for possible cybersecurity risk"
    );
  });

  test("returns null for unrelated errors", () => {
    const error = new ProxyError("Upstream error", 429, {
      body: '{"error":{"message":"rate limited"}}',
      providerId: 1,
      providerName: "p",
    });
    expect(detectCyberRiskFallbackTrigger(error, "rate limited")).toBeNull();
    expect(detectCyberRiskFallbackTrigger("not an error")).toBeNull();
  });

  test("collects every text surface", () => {
    const error = new ProxyError("msg", 400, {
      body: "body",
      providerId: 1,
      providerName: "p",
      rawBody: "raw",
    });
    expect(collectCyberRiskErrorTexts(error, "detail")).toEqual(["detail", "msg", "body", "raw"]);
  });
});

describe("resolveCyberRiskFallback", () => {
  const rules: ProviderModelRedirectRule[] = [
    { matchType: "exact", source: "gpt-5.5", target: "gpt-5.4" },
    { matchType: "regex", source: "^gpt-(.+)-codex$", target: "gpt-$1" },
    { matchType: "prefix", source: "claude-opus", target: "claude-sonnet-4-6" },
  ];

  test("matches the execution model exactly", () => {
    expect(resolveCyberRiskFallback(rules, "gpt-5.5")).toEqual({
      matchedModel: "gpt-5.5",
      fromModel: "gpt-5.5",
      toModel: "gpt-5.4",
      rule: rules[0],
    });
  });

  test("expands regex capture groups", () => {
    expect(resolveCyberRiskFallback(rules, "gpt-5.5-codex")?.toModel).toBe("gpt-5.5");
  });

  test("matches prefix rules", () => {
    expect(resolveCyberRiskFallback(rules, "claude-opus-4-7")?.toModel).toBe("claude-sonnet-4-6");
  });

  test("falls back to the original model when the execution model does not match", () => {
    const resolution = resolveCyberRiskFallback(rules, "upstream-luna", "gpt-5.5");
    expect(resolution).toMatchObject({
      matchedModel: "gpt-5.5",
      fromModel: "upstream-luna",
      toModel: "gpt-5.4",
    });
  });

  test("returns null when no rule matches", () => {
    expect(resolveCyberRiskFallback(rules, "gemini-2.5-pro", "gemini-2.5-pro")).toBeNull();
  });

  test("returns null for empty rules or missing model", () => {
    expect(resolveCyberRiskFallback(null, "gpt-5.5")).toBeNull();
    expect(resolveCyberRiskFallback([], "gpt-5.5")).toBeNull();
    expect(resolveCyberRiskFallback(rules, null)).toBeNull();
  });

  test("refuses a no-op fallback to the same model", () => {
    expect(
      resolveCyberRiskFallback(
        [{ matchType: "prefix", source: "gpt", target: "gpt-5.5" }],
        "gpt-5.5"
      )
    ).toBeNull();
  });
});

describe("ModelRedirector with cyber risk fallback override", () => {
  test("applies the fallback model to body, buffer, note and redirect audit", () => {
    const provider = createProvider();
    const session = createSession("gpt-5.5");
    session.setCyberRiskFallbackModel(35, "gpt-5.5", "gpt-5.4");

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe("gpt-5.4");
    expect(session.request.message.model).toBe("gpt-5.4");
    expect(decodeBody(session).model).toBe("gpt-5.4");
    expect(session.getOriginalModel()).toBe("gpt-5.5");
    expect(session.request.note).toContain("Cyber Risk Fallback: gpt-5.5 → gpt-5.4");
    expect(session.getCurrentModelRedirect(35)).toMatchObject({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.4",
      billingModel: "gpt-5.5",
      matchedRule: { matchType: "exact", source: "gpt-5.5", target: "gpt-5.4" },
    });
  });

  test("is idempotent across repeated attempts and stacks on top of model redirects", () => {
    const provider = createProvider({
      modelRedirects: [{ matchType: "exact", source: "gpt-5.5", target: "luna-5.5" }],
    });
    const session = createSession("gpt-5.5");

    ModelRedirector.apply(session, provider);
    expect(session.request.model).toBe("luna-5.5");

    session.setCyberRiskFallbackModel(35, "luna-5.5", "luna-5.4");
    ModelRedirector.apply(session, provider);
    ModelRedirector.apply(session, provider);
    expect(session.request.model).toBe("luna-5.4");
    expect(session.getOriginalModel()).toBe("gpt-5.5");
    expect(session.getCurrentModelRedirect(35)?.matchedRule?.source).toBe("luna-5.5");
  });

  test("is ignored for a different provider", () => {
    const session = createSession("gpt-5.5");
    session.setCyberRiskFallbackModel(35, "gpt-5.5", "gpt-5.4");

    expect(ModelRedirector.apply(session, createProvider({ id: 99 }))).toBe(false);
    expect(session.request.model).toBe("gpt-5.5");
  });

  test("state accessors copy, restore and clear the override", () => {
    const session = createSession("gpt-5.5");
    expect(session.getCyberRiskFallbackState()).toBeNull();
    session.setCyberRiskFallbackModel(35, "gpt-5.5", "gpt-5.4");
    const state = session.getCyberRiskFallbackState();
    expect(state).toEqual({ providerId: 35, fromModel: "gpt-5.5", model: "gpt-5.4" });

    const other = createSession("gpt-5.5");
    other.setCyberRiskFallbackState(state);
    expect(other.getCyberRiskFallbackModel(35)?.model).toBe("gpt-5.4");
    expect(other.getCyberRiskFallbackModel(1)).toBeNull();

    other.clearCyberRiskFallbackModel();
    expect(other.getCyberRiskFallbackModel(35)).toBeNull();
    other.setCyberRiskFallbackState(null);
    expect(other.getCyberRiskFallbackState()).toBeNull();
  });
});
