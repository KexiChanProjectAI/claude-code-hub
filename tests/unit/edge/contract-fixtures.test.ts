/**
 * 跨语言契约校验：
 * - edge/internal/contract 生成的 Go 载荷（go-samples.json）必须通过 TS zod 校验；
 * - TS 产出的响应（ts-samples.json，含真实 step 构建结果）由 Go 侧严格解码（未知字段即失败）。
 * 更新：UPDATE_FIXTURES=1 bunx vitest run tests/unit/edge/contract-fixtures.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getCachedSystemSettings: vi.fn(async () => ({
      enableBillingHeaderRectifier: true,
      enableClaudeMetadataUserIdInjection: true,
      enableResponseFixer: true,
      responseFixerConfig: null,
    })),
    isHttp2Enabled: vi.fn(async () => false),
  };
});
vi.mock("@/repository/message", () => ({ updateMessageRequestDetails: vi.fn(async () => {}) }));
vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: { applyFinal: vi.fn(async () => {}) },
}));

import {
  CompleteRequestSchema,
  type DecideResponse,
  HeartbeatRequestSchema,
  type NextResponse,
  NextRequestSchema,
} from "@/app/v1/_lib/edge/contract";
import { buildRequestDigest, createEdgeSessionFromDigest } from "@/app/v1/_lib/edge/digest";
import { buildExecutionStep } from "@/app/v1/_lib/edge/step-builder";
import type { Provider } from "@/types/provider";

const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures/edge/contract");

describe("edge contract fixtures", () => {
  test("Go samples validate against the zod schemas", () => {
    const samples = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, "go-samples.json"), "utf8")
    ) as Record<string, unknown>;
    expect(Object.keys(samples).length).toBeGreaterThan(5);
    for (const [name, sample] of Object.entries(samples)) {
      const schema = name.startsWith("next")
        ? NextRequestSchema
        : name.startsWith("complete")
          ? CompleteRequestSchema
          : HeartbeatRequestSchema;
      const parsed = schema.safeParse(sample);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  test("TS samples are current", async () => {
    const body = {
      model: "claude-sonnet-4-5",
      stream: true,
      max_tokens: 1024,
      system: [{ type: "text", text: "x-anthropic-billing-header: v" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      _private: 1,
    };
    const digest = buildRequestDigest({
      edgeId: "edge-1",
      edgeRequestId: "req-1",
      receivedAtMs: 1_700_000_000_000,
      method: "POST",
      path: "/v1/messages?beta=true",
      headers: [
        ["content-type", "application/json"],
        ["user-agent", "claude-cli/2.1.90"],
      ],
      clientIp: "10.0.0.1",
      body,
      bodyBytes: 100,
    });
    const session = createEdgeSessionFromDigest(digest);
    session.setAuthState({
      user: { id: 1, name: "u" } as never,
      key: { id: 2, name: "k", cacheTtlPreference: "1h" } as never,
      apiKey: "sk",
      success: true,
    });
    session.setSessionId("sess_contract");
    const provider = {
      id: 9,
      name: "p9",
      url: "https://api.example.com",
      key: "sk-up",
      providerType: "claude",
      priority: 1,
      preserveClientIp: false,
      firstByteTimeoutStreamingMs: 30_000,
      requestTimeoutNonStreamingMs: 0,
      streamingIdleTimeoutMs: 60_000,
      proxyUrl: null,
      proxyFallbackToDirect: false,
      cacheTtlPreference: null,
      customHeaders: null,
      modelRedirects: null,
    } as unknown as Provider;
    const step = await buildExecutionStep({
      session,
      body: { originalTopLevel: digest.topLevel, hasPrivateParams: true, contentOps: [] },
      provider,
      endpoint: { endpointId: 3, baseUrl: "https://api.example.com" },
      stepId: "7:1:1",
      attemptNumber: 1,
      totalProvidersAttempted: 1,
      attemptKind: "normal",
      applyProviderOverrides: true,
      delayMs: 0,
      hedge: null,
      heartbeatIntervalMs: 15_000,
    });

    const failResponse = {
      status: 429,
      headers: [["content-type", "application/json; charset=utf-8"]] as Array<[string, string]>,
      bodyText:
        '{"error":{"message":"limited","type":"rate_limit_error","code":"rate_limit_error"}}',
    };
    const decideExecute: DecideResponse = {
      action: "execute",
      requestId: 7,
      edgeToken: "t".repeat(48),
      step,
    };
    const decideDelegate: DecideResponse = { action: "delegate", reason: "edge_disabled" };
    const decideFail: DecideResponse = { action: "fail", response: failResponse };
    const nextRetry: NextResponse = {
      action: "retry",
      step: { ...step, stepId: "7:1:2", delayMs: 100 },
    };
    const nextFail: NextResponse = { action: "fail", response: failResponse };

    const responsesDigest = buildRequestDigest({
      edgeId: "edge-1",
      edgeRequestId: "req-2",
      receivedAtMs: 1_700_000_000_000,
      method: "POST",
      path: "/v1/responses",
      headers: [["user-agent", "codex_cli_rs/0.50.0"]],
      clientIp: null,
      body: { model: "gpt-5-codex", stream: true, input: "hello", reasoning: { effort: "high" } },
      bodyBytes: 80,
    });
    const codexSession = createEdgeSessionFromDigest(responsesDigest);
    codexSession.setOriginalFormat("response");
    const codexStep = await buildExecutionStep({
      session: codexSession,
      body: {
        originalTopLevel: responsesDigest.topLevel,
        hasPrivateParams: false,
        contentOps: [{ op: "normalize_response_input" }],
      },
      provider: {
        ...provider,
        id: 11,
        providerType: "codex",
        url: "https://api.openai.example.com/v1",
      } as Provider,
      endpoint: { endpointId: null, baseUrl: "https://api.openai.example.com/v1" },
      stepId: "8:h1:1",
      attemptNumber: 1,
      totalProvidersAttempted: 1,
      attemptKind: "normal",
      applyProviderOverrides: true,
      delayMs: 0,
      hedge: { thresholdMs: 30_000, maxInFlight: 2, billLosers: true, loserDrainMs: 120_000 },
      heartbeatIntervalMs: 15_000,
    });
    const nextLaunch: NextResponse = {
      action: "launch",
      step: { ...codexStep, stepId: "8:h2:1", attemptKind: "hedge" },
    };
    const samples = {
      digest,
      digest_responses: responsesDigest,
      decide_execute_hedge: {
        action: "execute",
        requestId: 8,
        edgeToken: "t".repeat(48),
        step: codexStep,
      } satisfies DecideResponse,
      next_launch: nextLaunch,
      next_wait: { action: "wait" } satisfies NextResponse,
      decide_execute: decideExecute,
      decide_delegate: decideDelegate,
      decide_fail: decideFail,
      next_retry: nextRetry,
      next_fail: nextFail,
      next_none: { action: "none" } satisfies NextResponse,
      next_commit: { action: "commit" } satisfies NextResponse,
      next_delegate: { action: "delegate", reason: "x" } satisfies NextResponse,
    };
    const encoded = `${JSON.stringify(samples, null, 2)}\n`;
    const target = path.join(FIXTURE_DIR, "ts-samples.json");
    if (process.env.UPDATE_FIXTURES) {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      fs.writeFileSync(target, encoded);
    }
    expect(fs.readFileSync(target, "utf8")).toBe(encoded);
  });
});
