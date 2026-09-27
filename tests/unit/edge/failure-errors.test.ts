import { describe, expect, test } from "vitest";
import {
  attemptFailureToError,
  evaluateSuspectNonStreamBody,
} from "@/app/v1/_lib/edge/failure-errors";
import {
  categorizeErrorAsync,
  EmptyResponseError,
  ErrorCategory,
  isTransportError,
  ProxyError,
} from "@/app/v1/_lib/proxy/errors";
import {
  isRequestScopedGateFailure,
  StreamPrecommitError,
} from "@/app/v1/_lib/proxy/stream-gate/stream-content-gate";
import { isLocalCapacityError } from "@/lib/memory/governor";
import type { Provider } from "@/types/provider";

const PROVIDER = {
  id: 3,
  name: "p3",
  providerType: "claude",
  firstByteTimeoutStreamingMs: 5000,
  requestTimeoutNonStreamingMs: 60_000,
  streamingIdleTimeoutMs: 90_000,
} as unknown as Provider;

describe("attemptFailureToError", () => {
  test("upstream status becomes a ProxyError with parsed body and request id", () => {
    const error = attemptFailureToError(
      {
        kind: "upstream_status",
        status: 429,
        statusText: "Too Many Requests",
        headers: [
          ["content-type", "application/json"],
          ["request-id", "req_1"],
        ],
        bodyText: '{"error":{"type":"rate_limit_error","message":"slow down"}}',
        bodyTruncated: false,
      },
      PROVIDER
    ) as ProxyError;
    expect(error).toBeInstanceOf(ProxyError);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe("rate_limit_error: slow down");
    expect(error.upstreamError?.requestId).toBe("req_1");
  });

  test("transport failures are classified as system errors", async () => {
    const error = attemptFailureToError(
      { kind: "transport", code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
      PROVIDER
    );
    expect(isTransportError(error)).toBe(true);
    expect(await categorizeErrorAsync(error)).toBe(ErrorCategory.SYSTEM_ERROR);
  });

  test.each([
    ["streaming_first_byte", "streaming_first_byte", 5000],
    ["non_streaming_total", "non_streaming_total", 60_000],
  ] as const)("%s timeout maps to a 524 with provider timeout", (timeoutType, expected, ms) => {
    const error = attemptFailureToError({ kind: "timeout", timeoutType }, PROVIDER) as ProxyError;
    expect(error.statusCode).toBe(524);
    expect(error.upstreamError?.parsed).toMatchObject({
      error: { timeout_type: expected, timeout_ms: ms },
    });
  });

  test("idle and first-content timeouts use their dedicated builders", () => {
    const idle = attemptFailureToError(
      { kind: "timeout", timeoutType: "streaming_idle" },
      PROVIDER
    ) as ProxyError;
    expect(idle.upstreamError?.parsed).toMatchObject({ error: { type: "streaming_idle_timeout" } });
    const firstContent = attemptFailureToError(
      { kind: "timeout", timeoutType: "streaming_first_valid_content" },
      PROVIDER
    ) as ProxyError;
    expect(firstContent.upstreamError?.body).toContain("streaming_first_valid_content");
  });

  test("gate failures rebuild StreamPrecommitError with inferred status", () => {
    const gate = attemptFailureToError(
      {
        kind: "gate",
        reason: "gate_error",
        frameData: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
        inferenceText: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
        terminalBeforeContent: false,
        framesSeen: 1,
        bufferedBytes: 10,
        echoExcludedBytes: 0,
      },
      PROVIDER
    );
    expect(gate).toBeInstanceOf(StreamPrecommitError);
    expect((gate as StreamPrecommitError).gateFamily).toBe("anthropic");
    const empty = attemptFailureToError(
      {
        kind: "gate",
        reason: "empty_stream",
        frameData: "",
        inferenceText: "",
        terminalBeforeContent: true,
        framesSeen: 2,
        bufferedBytes: 0,
        echoExcludedBytes: 0,
      },
      PROVIDER
    ) as StreamPrecommitError;
    expect(empty.statusCode).toBe(502);
    expect(isRequestScopedGateFailure(empty)).toBe(false);
  });

  test("empty responses, client aborts, local capacity and invalid steps", async () => {
    const empty = attemptFailureToError(
      { kind: "empty_response", reason: "missing_content" },
      PROVIDER
    );
    expect(empty).toBeInstanceOf(EmptyResponseError);
    const abort = attemptFailureToError({ kind: "client_abort" }, PROVIDER) as ProxyError;
    expect(abort.statusCode).toBe(499);
    expect(abort.isLocalAbort).toBe(true);
    expect(await categorizeErrorAsync(abort)).toBe(ErrorCategory.CLIENT_ABORT);
    const capacity = attemptFailureToError({ kind: "local_capacity", message: "full" }, PROVIDER);
    expect(isLocalCapacityError(capacity)).toBe(true);
    const invalid = attemptFailureToError(
      { kind: "invalid_step", message: "unknown op" },
      PROVIDER
    );
    expect(invalid.message).toContain("EDGE_INVALID_STEP");
  });
});

describe("evaluateSuspectNonStreamBody", () => {
  test("normal JSON bodies are committed", () => {
    expect(
      evaluateSuspectNonStreamBody(
        '{"type":"message","content":[{"type":"text"}]}',
        false,
        PROVIDER
      )
    ).toBeNull();
  });

  test("HTML error pages become synthetic fake-200 errors", () => {
    const error = evaluateSuspectNonStreamBody(
      "<!DOCTYPE html><html><body>Bad gateway</body></html>",
      false,
      PROVIDER
    ) as ProxyError;
    expect(error).toBeInstanceOf(ProxyError);
    expect(error.message).toBe("FAKE_200_HTML_BODY");
    expect(error.upstreamError?.isSyntheticFake200).toBe(true);
  });

  test("JSON error payloads are rejected and empty bodies become empty responses", () => {
    const error = evaluateSuspectNonStreamBody(
      '{"error":{"message":"quota exceeded"}}',
      false,
      PROVIDER
    ) as ProxyError;
    expect(error.upstreamError?.isSyntheticFake200).toBe(true);
    expect(evaluateSuspectNonStreamBody("   ", false, PROVIDER)).toBeInstanceOf(EmptyResponseError);
  });
});
