import { describe, expect, test } from "vitest";
import { RequestDigestSchema } from "@/app/v1/_lib/edge/contract";
import {
  buildRequestDigest,
  buildSyntheticMessage,
  createEdgeSessionFromDigest,
} from "@/app/v1/_lib/edge/digest";
import {
  evaluateProviderEligibility,
  evaluateRequestEligibility,
} from "@/app/v1/_lib/edge/eligibility";
import { extractInitialMessageTextHash } from "@/app/v1/_lib/codex/session-completer";
import { computeFingerprintChain } from "@/app/v1/_lib/proxy/affinity/fingerprint";
import { rectifyResponseInput } from "@/app/v1/_lib/proxy/response-input-rectifier";
import { computeSessionFingerprintChain } from "@/app/v1/_lib/proxy/edge-digest-hints";
import { SessionManager } from "@/lib/session-manager";
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";

const BODY = {
  model: "claude-sonnet-4-5",
  stream: true,
  max_tokens: 100,
  metadata: { user_id: "x" },
  system: "be nice",
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "again", _note: 1 }] },
  ],
};

const RESPONSES_BODY = {
  model: "gpt-5-codex",
  stream: true,
  instructions: "sys",
  reasoning: { effort: "high" },
  parallel_tool_calls: true,
  prompt_cache_key: "pck",
  input: [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
};

const CHAT_BODY = {
  model: "gpt-4.1",
  stream: true,
  stream_options: { include_usage: false },
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
};

function digestFor(body: Record<string, unknown>, path = "/v1/messages") {
  return buildRequestDigest({
    edgeId: "e",
    edgeRequestId: "r",
    receivedAtMs: 1,
    method: "POST",
    path,
    headers: [["user-agent", "claude-cli/2.1.90"]],
    clientIp: "1.2.3.4",
    body,
    bodyBytes: JSON.stringify(body).length,
  });
}

const SETTINGS = {
  edgeExecutionEnabled: true,
  interceptAnthropicWarmupRequests: false,
  discoveryEnabled: false,
  fakeStreamingWhitelist: [],
} as unknown as SystemSettings;

describe("request digest", () => {
  test("captures top-level fields, counts and content-derived hints", () => {
    const digest = digestFor(BODY);
    expect(RequestDigestSchema.parse(digest)).toEqual(digest);
    expect(digest.topLevel).toEqual({
      model: "claude-sonnet-4-5",
      stream: true,
      max_tokens: 100,
      metadata: { user_id: "x" },
    });
    expect(digest.messagesCount).toBe(3);
    expect(digest.systemKind).toBe("string");
    expect(digest.hasPrivateParams).toBe(true);
    expect(digest.isProbe).toBe(false);
    expect(digest.messagesHash).toBe(SessionManager.calculateMessagesHash(BODY.messages));
    expect(digest.fingerprint).toEqual(computeFingerprintChain(BODY, "claude", 64));
  });

  test("detects probe and warmup requests", () => {
    expect(digestFor({ model: "m", messages: [{ role: "user", content: " Foo " }] }).isProbe).toBe(
      true
    );
    const warmup = digestFor({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Warmup", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect(warmup.isWarmup).toBe(true);
    expect(digestFor({ model: "m", messages: [] }).systemKind).toBe("absent");
  });

  test("edge session exposes synthetic body and precomputed hints", () => {
    const digest = digestFor(BODY);
    const synthetic = buildSyntheticMessage(digest);
    expect(synthetic.messages).toHaveLength(3);
    const session = createEdgeSessionFromDigest(digest);
    expect(session.request.model).toBe("claude-sonnet-4-5");
    expect(session.getMessagesLength()).toBe(3);
    expect(session.isProbeRequest()).toBe(false);
    expect(computeSessionFingerprintChain(session, 2)?.tail).toHaveLength(2);
    expect(computeSessionFingerprintChain(session, 2)?.tail).toEqual(
      computeFingerprintChain(BODY, "claude", 2)?.tail
    );
    expect(session.userAgent).toBe("claude-cli/2.1.90");
  });
});

describe("edge eligibility", () => {
  const base = {
    settings: SETTINGS,
    headers: new Headers(),
    sensitiveWordsConfigured: false,
    globalBodyFiltersConfigured: false,
  };

  test("accepts a plain claude messages request", () => {
    expect(evaluateRequestEligibility({ ...base, digest: digestFor(BODY) })).toEqual({
      eligible: true,
    });
    expect(
      evaluateRequestEligibility({ ...base, digest: digestFor(BODY, "/messages?beta=true") })
    ).toEqual({ eligible: false, reason: "unsupported_endpoint" });
  });

  test.each([
    ["edge_disabled", { settings: { ...SETTINGS, edgeExecutionEnabled: false } }, {}],
    ["unsupported_endpoint", {}, { path: "/v1/messages/count_tokens" }],
    ["unsupported_endpoint", {}, { path: "/v1/embeddings" }],
    ["unsupported_endpoint", {}, { path: "/v1/chat/completions" }],
    ["remote_compaction", {}, { isRemoteCompactionV2: true }],
    ["unsupported_method", {}, { method: "GET" }],
    ["body_parse_error", {}, { bodyParseError: "bad json" }],
    ["probe_request", {}, { isProbe: true }],
    [
      "warmup_intercept",
      { settings: { ...SETTINGS, interceptAnthropicWarmupRequests: true } },
      { isWarmup: true },
    ],
    ["sensitive_words_configured", { sensitiveWordsConfigured: true }, {}],
    ["request_filter_body_ops", { globalBodyFiltersConfigured: true }, {}],
    ["discovery_enabled", { settings: { ...SETTINGS, discoveryEnabled: true } }, {}],
  ] as const)("delegates %s", (reason, overrides, digestOverrides) => {
    const digest = { ...digestFor(BODY), ...digestOverrides };
    expect(evaluateRequestEligibility({ ...base, ...overrides, digest } as never)).toEqual({
      eligible: false,
      reason,
    });
  });

  test("provider level checks", () => {
    const provider = { providerType: "claude", groupTag: null } as unknown as Provider;
    expect(
      evaluateProviderEligibility({
        provider,
        format: "claude",
        requestedModel: "m",
        settings: SETTINGS,
        providerBodyFiltersConfigured: false,
      })
    ).toEqual({ eligible: true });
    expect(
      evaluateProviderEligibility({
        provider: { ...provider, providerType: "codex" } as Provider,
        format: "claude",
        requestedModel: "m",
        settings: SETTINGS,
        providerBodyFiltersConfigured: false,
      })
    ).toEqual({ eligible: false, reason: "provider_type" });
    expect(
      evaluateProviderEligibility({
        provider,
        format: "claude",
        requestedModel: "m",
        settings: SETTINGS,
        providerBodyFiltersConfigured: true,
      })
    ).toEqual({ eligible: false, reason: "provider_request_filter_body_ops" });
    expect(
      evaluateProviderEligibility({
        provider,
        format: "claude",
        requestedModel: "m",
        settings: {
          ...SETTINGS,
          fakeStreamingWhitelist: [{ model: "m", groupTags: [] }],
        } as SystemSettings,
        providerBodyFiltersConfigured: false,
      })
    ).toEqual({ eligible: false, reason: "fake_streaming" });
  });

  test("provider type must match the client format", () => {
    const codex = { providerType: "codex", groupTag: null } as unknown as Provider;
    const chat = { providerType: "openai-compatible", groupTag: null } as unknown as Provider;
    const check = (provider: Provider, format: "claude" | "response" | "openai") =>
      evaluateProviderEligibility({
        provider,
        format,
        requestedModel: "m",
        settings: SETTINGS,
        providerBodyFiltersConfigured: false,
      });
    expect(check(codex, "response")).toEqual({ eligible: true });
    expect(check(chat, "openai")).toEqual({ eligible: true });
    expect(check(chat, "response")).toEqual({ eligible: false, reason: "provider_type" });
    expect(check(codex, "openai")).toEqual({ eligible: false, reason: "provider_type" });
    expect(
      check({ ...codex, codexImageGenerationPreference: "disabled" } as Provider, "response")
    ).toEqual({ eligible: false, reason: "codex_image_generation_preference" });
    expect(
      check({ ...codex, codexImageGenerationPreference: "inherit" } as Provider, "response")
    ).toEqual({ eligible: true });
  });

  test("accepts responses and chat completions requests", () => {
    const responses = digestFor(RESPONSES_BODY, "/v1/responses");
    expect(evaluateRequestEligibility({ ...base, digest: responses })).toEqual({ eligible: true });
    const chat = digestFor(CHAT_BODY, "/v1/chat/completions");
    expect(evaluateRequestEligibility({ ...base, digest: chat })).toEqual({ eligible: true });
  });

  test("delegates input normalization when the rectifier is disabled", () => {
    const digest = digestFor({ model: "gpt-5", input: "hello" }, "/v1/responses");
    expect(
      evaluateRequestEligibility({
        ...base,
        settings: { ...SETTINGS, enableResponseInputRectifier: false } as SystemSettings,
        digest,
      })
    ).toEqual({ eligible: false, reason: "response_input_rectifier_disabled" });
    expect(evaluateRequestEligibility({ ...base, digest })).toEqual({ eligible: true });
  });
});

describe("request digest for openai formats", () => {
  test("responses digest normalizes input and hashes the normalized items", () => {
    const digest = digestFor({ model: "gpt-5", stream: true, input: "hi there" }, "/v1/responses");
    expect(RequestDigestSchema.parse(digest)).toEqual(digest);
    expect(digest.format).toBe("response");
    expect(digest.inputCount).toBe(1);
    expect(digest.messagesCount).toBeNull();
    expect(digest.responseInputRectify).toEqual({
      action: "string_to_array",
      originalType: "string",
    });
    const normalized = { model: "gpt-5", stream: true, input: "hi there" } as Record<
      string,
      unknown
    >;
    rectifyResponseInput(normalized);
    expect(digest.messagesHash).toBe(
      SessionManager.calculateMessagesHash(normalized.input as unknown[])
    );
    expect(digest.fingerprint).toEqual(computeFingerprintChain(normalized, "response", 64));
    expect(digest.codexInitialTextHash).toBe(extractInitialMessageTextHash(normalized));

    const session = createEdgeSessionFromDigest(digest);
    expect((session.request.message.input as unknown[]).length).toBe(1);
    expect(session.getMessagesLength()).toBe(1);
  });

  test("responses digest keeps codex top-level fields", () => {
    const digest = digestFor(RESPONSES_BODY, "/v1/responses");
    expect(digest.responseInputRectify).toEqual({ action: "passthrough", originalType: "array" });
    expect(digest.topLevel).toEqual({
      model: "gpt-5-codex",
      stream: true,
      reasoning: { effort: "high" },
      parallel_tool_calls: true,
      prompt_cache_key: "pck",
    });
    expect(digest.inputCount).toBe(2);
  });

  test("chat digest uses messages and openai fingerprint", () => {
    const digest = digestFor(CHAT_BODY, "/v1/chat/completions");
    expect(digest.format).toBe("openai");
    expect(digest.messagesCount).toBe(2);
    expect(digest.inputCount).toBeNull();
    expect(digest.responseInputRectify).toBeNull();
    expect(digest.topLevel.stream_options).toEqual({ include_usage: false });
    expect(digest.fingerprint).toEqual(computeFingerprintChain(CHAT_BODY, "openai", 64));
  });
});
