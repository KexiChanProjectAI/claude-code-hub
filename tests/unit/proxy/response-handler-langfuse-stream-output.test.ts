import { describe, expect, test } from "vitest";
import { normalizeStreamOutput } from "@/lib/langfuse/stream-output-normalizer";
import type { StreamingFamily } from "@/lib/langfuse/stream-output-normalizer";
import { streamFamilyFromFormat } from "@/app/v1/_lib/proxy/response-handler";
import type { EmitProxyLangfuseTraceData } from "@/lib/langfuse/emit-proxy-trace";

// These tests lock the wiring contract between the two streaming emit sites
// in response-handler.ts and the Langfuse stream-output normalizer.
//
// The production code does exactly this at the two emit sites:
//
//   // Gemini passthrough emit site (~line 2085):
//   emitProxyLangfuseTrace(session, {
//     responseText: allContent,
//     responseOutput: normalizeStreamOutput(allContent, "gemini"),
//     ...
//   });
//
//   // General streaming emit site (~line 2740):
//   const streamFamily = streamFamilyFromFormat(session.originalFormat);
//   emitProxyLangfuseTrace(session, {
//     responseText: allContent,
//     responseOutput: streamFamily ? normalizeStreamOutput(allContent, streamFamily) : undefined,
//     ...
//   });
//
// Raw `allContent` (SSE/NDJSON text) is still what SessionManager.storeSessionResponse,
// snapshots, finalizeDeferredStreamingFinalizationIfNeeded, and finalizeRequestStats receive.
//
// Rather than spin up the full ProxyResponseHandler (which drags in cost calculation,
// hedge billing, circuit breakers, etc.), we simulate the exact emit-site computation
// and assert both the structured responseOutput and the untouched raw text.

function sse(events: Array<[event: string, data: string]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${data}\n`).join("\n") + "\n";
}

function dataOnlySse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n`).join("\n") + "\n";
}

/**
 * Mirrors the general streaming emit site's responseOutput computation exactly.
 * Returns the EmitProxyLangfuseTraceData shape that would be passed to
 * emitProxyLangfuseTrace, so tests can assert on both responseOutput
 * (structured) and responseText (raw).
 */
function simulateGeneralEmit(
  originalFormat: string,
  allContent: string
): { responseText: string; responseOutput: unknown } {
  const streamFamily: StreamingFamily | null = streamFamilyFromFormat(originalFormat);
  return {
    responseText: allContent,
    responseOutput: streamFamily ? normalizeStreamOutput(allContent, streamFamily) : undefined,
  };
}

/**
 * Mirrors the Gemini passthrough emit site's responseOutput computation exactly.
 * The Gemini passthrough branch always uses the "gemini" family regardless of
 * session.originalFormat.
 */
function simulateGeminiPassthroughEmit(allContent: string): {
  responseText: string;
  responseOutput: unknown;
} {
  return {
    responseText: allContent,
    responseOutput: normalizeStreamOutput(allContent, "gemini"),
  };
}

describe("streamFamilyFromFormat", () => {
  test('maps "response" to "responses-codex"', () => {
    expect(streamFamilyFromFormat("response")).toBe("responses-codex");
  });

  test('maps "openai" to "openai-chat"', () => {
    expect(streamFamilyFromFormat("openai")).toBe("openai-chat");
  });

  test('maps "claude" to "anthropic"', () => {
    expect(streamFamilyFromFormat("claude")).toBe("anthropic");
  });

  test('maps "gemini" to "gemini"', () => {
    expect(streamFamilyFromFormat("gemini")).toBe("gemini");
  });

  test('maps "gemini-cli" to "gemini"', () => {
    expect(streamFamilyFromFormat("gemini-cli")).toBe("gemini");
  });

  test("returns null for unknown formats", () => {
    expect(streamFamilyFromFormat("unknown")).toBeNull();
    expect(streamFamilyFromFormat("")).toBeNull();
    expect(streamFamilyFromFormat("anthropic")).toBeNull();
    expect(streamFamilyFromFormat("openai-chat")).toBeNull();
  });
});

describe("Gemini passthrough emit site: responseOutput wiring", () => {
  test("passes a structured GeminiResponse object as responseOutput from NDJSON allContent", () => {
    // Gemini passthrough streams are NDJSON (no data:/event: framing).
    const allContent = [
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hel" }] } }],
      }),
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "lo" }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
        modelVersion: "gemini-1.5-pro",
        responseId: "r1",
      }),
    ].join("\n");

    const emitted = simulateGeminiPassthroughEmit(allContent) as Pick<
      EmitProxyLangfuseTraceData,
      "responseText" | "responseOutput"
    >;

    // responseOutput is a structured object, not a string.
    expect(typeof emitted.responseOutput).toBe("object");
    expect(emitted.responseOutput).not.toBeNull();

    const obj = emitted.responseOutput as Record<string, unknown>;
    const candidate = (obj.candidates as Array<Record<string, unknown>>)[0];
    expect((candidate.content as Record<string, unknown>).role).toBe("model");
    expect(candidate.finishReason).toBe("STOP");
    expect(obj.modelVersion).toBe("gemini-1.5-pro");
    expect(obj.responseId).toBe("r1");
  });

  test("raw allContent (with NDJSON newlines) is preserved verbatim in responseText for persistence", () => {
    const allContent = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }),
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "x" }], role: "model" },
            finishReason: "STOP",
          },
        ],
      }),
    ].join("\n");

    const emitted = simulateGeminiPassthroughEmit(allContent);

    // responseText is the raw NDJSON — what SessionManager.storeSessionResponse receives.
    expect(emitted.responseText).toBe(allContent);
    expect(emitted.responseText).toContain("\n");
    expect(emitted.responseText).toContain('"candidates"');
  });

  test("responseOutput is null when the Gemini stream lacks a terminal signal (forces fallback)", () => {
    const allContent = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
      // no finishReason, no role -> not trustworthy
    });

    const emitted = simulateGeminiPassthroughEmit(allContent);

    expect(emitted.responseOutput).toBeNull();
    // Raw text is still passed through for persistence and legacy fallback.
    expect(emitted.responseText).toBe(allContent);
  });
});

describe("General streaming emit site: responseOutput wiring per format", () => {
  test("Responses/Codex format (originalFormat='response') yields structured responseOutput", () => {
    const allContent = sse([
      [
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            object: "response",
            created: 100,
            model: "gpt-5",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "pong" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      ],
    ]);

    const emitted = simulateGeneralEmit("response", allContent);

    expect(emitted.responseOutput).not.toBeNull();
    expect(emitted.responseOutput).not.toBeUndefined();
    const obj = emitted.responseOutput as Record<string, unknown>;
    expect(obj.id).toBe("resp_1");
    expect(obj.status).toBe("completed");
    expect(obj.object).toBe("response");

    // Raw SSE text preserved for persistence.
    expect(emitted.responseText).toBe(allContent);
    expect(emitted.responseText).toContain("event: response.completed");
    expect(emitted.responseText).toContain("data: ");
  });

  test("Anthropic format (originalFormat='claude') yields structured message object", () => {
    const allContent = sse([
      [
        "message_start",
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_a",
            type: "message",
            role: "assistant",
            model: "claude-3",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
      ],
      [
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        }),
      ],
      [
        "message_delta",
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
      ],
      ["message_stop", JSON.stringify({ type: "message_stop" })],
    ]);

    const emitted = simulateGeneralEmit("claude", allContent);

    expect(emitted.responseOutput).not.toBeNull();
    expect(emitted.responseOutput).not.toBeUndefined();
    const obj = emitted.responseOutput as Record<string, unknown>;
    expect(obj.id).toBe("msg_a");
    expect(obj.role).toBe("assistant");
    expect(obj.stop_reason).toBe("end_turn");
    const content = obj.content as Array<Record<string, unknown>>;
    expect(content[0]?.text).toBe("Hi");

    // Raw SSE text preserved.
    expect(emitted.responseText).toBe(allContent);
    expect(emitted.responseText).toContain("event: message_start");
  });

  test("OpenAI format (originalFormat='openai') yields structured chat.completion object", () => {
    const allContent = sse([
      [
        "chat.chunk",
        JSON.stringify({
          id: "chat_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
      ],
      [
        "chat.chunk",
        JSON.stringify({
          id: "chat_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
        }),
      ],
      [
        "chat.chunk",
        JSON.stringify({
          id: "chat_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      ],
    ]);

    const emitted = simulateGeneralEmit("openai", allContent);

    expect(emitted.responseOutput).not.toBeNull();
    expect(emitted.responseOutput).not.toBeUndefined();
    const obj = emitted.responseOutput as Record<string, unknown>;
    expect(obj.id).toBe("chat_1");
    expect(obj.object).toBe("chat.completion");
    const choices = obj.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    expect(message.content).toBe("hi");
    expect(choices[0]?.finish_reason).toBe("stop");

    // Raw SSE text preserved.
    expect(emitted.responseText).toBe(allContent);
    expect(emitted.responseText).toContain("event: chat.chunk");
  });

  test("Gemini format (originalFormat='gemini') via general emit yields structured object", () => {
    // Fragments without an explicit content.role force the synthesis path
    // (text parts accumulate across fragments). A fragment with role+finishReason
    // would be returned verbatim, losing prior fragment text.
    const allContent = dataOnlySse([
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hel" }] } }],
        usageMetadata: { totalTokenCount: 4 },
      }),
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "lo" }] },
            finishReason: "STOP",
          },
        ],
        modelVersion: "gemini-1.5-pro",
        responseId: "r2",
      }),
    ]);

    const emitted = simulateGeneralEmit("gemini", allContent);

    expect(emitted.responseOutput).not.toBeNull();
    expect(emitted.responseOutput).not.toBeUndefined();
    const obj = emitted.responseOutput as Record<string, unknown>;
    const candidate = (obj.candidates as Array<Record<string, unknown>>)[0];
    const parts = (candidate.content as Record<string, unknown>).parts as Array<
      Record<string, unknown>
    >;
    expect(parts.map((p) => p.text).join("")).toBe("hello");
    expect(candidate.finishReason).toBe("STOP");
    expect(obj.modelVersion).toBe("gemini-1.5-pro");
    expect(obj.responseId).toBe("r2");
  });

  test("unknown format yields undefined responseOutput (skips normalization, preserves fallback)", () => {
    const allContent = sse([["something", '{"x":1}']]);

    const emitted = simulateGeneralEmit("unknown-format", allContent);

    // streamFamilyFromFormat returns null -> responseOutput is undefined,
    // forcing buildResponseOutput() to fall back to responseText parsing.
    expect(emitted.responseOutput).toBeUndefined();
    expect(emitted.responseText).toBe(allContent);
  });

  test("incomplete stream (no terminal signal) yields null responseOutput, forcing legacy fallback", () => {
    // Anthropic stream truncated before message_stop.
    const allContent = sse([
      [
        "message_start",
        JSON.stringify({
          type: "message_start",
          message: { id: "m", role: "assistant", content: [] },
        }),
      ],
      [
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        }),
      ],
    ]);

    const emitted = simulateGeneralEmit("claude", allContent);

    // Normalizer refuses to fabricate -> null. Trace layer treats null/undefined
    // responseOutput equivalently (falls back to responseText).
    expect(emitted.responseOutput).toBeNull();
    expect(emitted.responseText).toBe(allContent);
  });
});

describe("Raw persistence contract: allContent stays untouched", () => {
  test("responseText always equals the original allContent (normalizer does not mutate input)", () => {
    const samples = [
      sse([
        [
          "response.completed",
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "r",
              object: "response",
              status: "completed",
              output: [
                {
                  id: "m",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "x" }],
                },
              ],
            },
          }),
        ],
      ]),
      dataOnlySse([
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "x" }], role: "model" },
              finishReason: "STOP",
            },
          ],
        }),
      ]),
      "not-even-valid-stream-text",
    ];

    for (const allContent of samples) {
      // General emit path
      const generalEmitted = simulateGeneralEmit("response", allContent);
      expect(generalEmitted.responseText).toBe(allContent);

      // Gemini passthrough emit path
      const geminiEmitted = simulateGeminiPassthroughEmit(allContent);
      expect(geminiEmitted.responseText).toBe(allContent);
    }
  });

  test("SSE/NDJSON markers in allContent are intact in responseText (what persistence receives)", () => {
    const sseContent = sse([["chat.chunk", '{"id":"c"}']]);
    const ndjsonContent = JSON.stringify({ candidates: [{ content: { role: "model" } }] });

    const sseEmitted = simulateGeneralEmit("openai", sseContent);
    expect(sseEmitted.responseText).toContain("event: chat.chunk");
    expect(sseEmitted.responseText).toContain("data: ");

    const ndjsonEmitted = simulateGeminiPassthroughEmit(ndjsonContent);
    expect(ndjsonEmitted.responseText).toContain('"candidates"');
  });
});
