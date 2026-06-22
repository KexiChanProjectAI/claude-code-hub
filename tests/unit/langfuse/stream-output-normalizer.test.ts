import { describe, expect, test } from "vitest";
import {
  normalizeLangfuseStreamingOutput,
  normalizeStreamOutput,
} from "@/lib/langfuse/stream-output-normalizer";

// Failing-first tests for the Langfuse streaming-output normalizer.
// Each family is exercised with a trustworthy terminal fixture (asserts the
// canonical merged shape) and an incomplete-stream fixture (asserts no
// fabricated object is returned). The normalizer must NOT import production
// code from src/lib/provider-testing/utils/sse-collector.ts.

function sse(events: Array<[event: string, data: string]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${data}\n`).join("\n") + "\n";
}

function dataOnlySse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n`).join("\n") + "\n";
}

describe("normalizeLangfuseStreamingOutput", () => {
  describe("Responses/Codex", () => {
    test("returns response.completed.response verbatim when terminal object is present", () => {
      const body = sse([
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
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
              },
            },
          }),
        ],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "responses",
      });

      expect(out).not.toBeNull();
      expect((out as { id?: string }).id).toBe("resp_1");
      expect((out as { status?: string }).status).toBe("completed");
      expect((out as { object?: string }).object).toBe("response");
    });

    test("synthesizes minimal ResponseObject from done + created events when terminal response lacks output", () => {
      const body =
        sse([
          [
            "response.created",
            JSON.stringify({
              type: "response.created",
              response: {
                id: "resp_2",
                object: "response",
                created: 200,
                model: "gpt-5",
                status: "generating",
              },
            }),
          ],
          [
            "response.output_text.done",
            JSON.stringify({
              type: "response.output_text.done",
              text: "hello",
            }),
          ],
        ]) +
        sse([
          [
            "response.completed",
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_2",
                object: "response",
                created: 200,
                model: "gpt-5",
                status: "completed",
                usage: {
                  input_tokens: 3,
                  output_tokens: 4,
                  total_tokens: 7,
                },
              },
            }),
          ],
        ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "responses",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      expect(obj.id).toBe("resp_2");
      expect(obj.object).toBe("response");
      expect(obj.status).toBe("completed");
      expect(obj.model).toBe("gpt-5");
      expect(Array.isArray(obj.output)).toBe(true);
      const message = (obj.output as Array<Record<string, unknown>>)[0];
      expect(message.type).toBe("message");
      expect(message.role).toBe("assistant");
      expect(message.status).toBe("completed");
      expect((message.content as Array<Record<string, unknown>>)[0].text).toBe("hello");
      const usage = obj.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(3);
      expect(usage.output_tokens).toBe(4);
      expect(usage.total_tokens).toBe(7);
    });

    test("refuses normalization for incomplete stream with only output_text.delta", () => {
      const body = sse([
        [
          "response.output_text.delta",
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "partial",
          }),
        ],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "responses",
      });

      // No terminal evidence (no response.completed, no output_text.done).
      expect(out).toBeNull();
    });

    test("refuses normalization when terminal status is failed/incomplete", () => {
      const body = sse([
        [
          "response.failed",
          JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_x",
              object: "response",
              status: "failed",
            },
          }),
        ],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "responses",
      });

      expect(out).toBeNull();
    });
  });

  describe("Anthropic", () => {
    test("reconstructs text-only message object from message_start..message_stop", () => {
      const body = sse([
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
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        ],
        [
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          }),
        ],
        [
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          }),
        ],
        ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })],
        [
          "message_delta",
          JSON.stringify({
            type: "message_delta",
            delta: {
              stop_reason: "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 2 },
          }),
        ],
        ["message_stop", JSON.stringify({ type: "message_stop" })],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "anthropic",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      expect(obj.id).toBe("msg_a");
      expect(obj.role).toBe("assistant");
      expect(obj.stop_reason).toBe("end_turn");
      const content = obj.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toBe("Hello");
      const usage = obj.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(5);
      expect(usage.output_tokens).toBe(2);
    });

    test("assembles tool_use input from input_json_delta partial_json", () => {
      const body = sse([
        [
          "message_start",
          JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_t",
              type: "message",
              role: "assistant",
              model: "claude-3",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
        ],
        [
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_1",
              name: "get_weather",
              input: {},
            },
          }),
        ],
        [
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"city":',
            },
          }),
        ],
        [
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '"SF"}',
            },
          }),
        ],
        ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })],
        [
          "message_delta",
          JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 9 },
          }),
        ],
        ["message_stop", JSON.stringify({ type: "message_stop" })],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "anthropic",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      const block = (obj.content as Array<Record<string, unknown>>)[0];
      expect(block.type).toBe("tool_use");
      expect(block.id).toBe("tool_1");
      expect(block.name).toBe("get_weather");
      expect(block.input).toEqual({ city: "SF" });
      expect(obj.stop_reason).toBe("tool_use");
    });

    test("refuses normalization for truncated stream without message_stop", () => {
      const body = sse([
        [
          "message_start",
          JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_trunc",
              role: "assistant",
              model: "claude-3",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
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

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "anthropic",
      });

      expect(out).toBeNull();
    });
  });

  describe("OpenAI Chat", () => {
    test("synthesizes chat.completion from streamed chunks with merged content + finish_reason", () => {
      const body = sse([
        [
          "chat.chunk",
          JSON.stringify({
            id: "chat_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          }),
        ],
        [
          "chat.chunk",
          JSON.stringify({
            id: "chat_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: { content: "hi" },
                finish_reason: null,
              },
            ],
          }),
        ],
        [
          "chat.chunk",
          JSON.stringify({
            id: "chat_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          }),
        ],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "openai-chat",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      expect(obj.id).toBe("chat_1");
      expect(obj.object).toBe("chat.completion");
      expect(obj.model).toBe("gpt-4o");
      const choices = obj.choices as Array<Record<string, unknown>>;
      expect(choices).toHaveLength(1);
      const message = choices[0]?.message as Record<string, unknown>;
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("hi");
      expect(choices[0]?.finish_reason).toBe("stop");
    });

    test("refuses normalization for chunk stream without any finish_reason", () => {
      const body = sse([
        [
          "chat.chunk",
          JSON.stringify({
            id: "chat_2",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
          }),
        ],
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "openai-chat",
      });

      expect(out).toBeNull();
    });
  });

  describe("Gemini", () => {
    test("returns latest complete object with candidates when terminal object present", () => {
      const body = dataOnlySse([
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "hel" }] },
            },
          ],
        }),
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "hello" }],
                role: "model",
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 3,
            totalTokenCount: 5,
          },
          modelVersion: "gemini-1.5-pro",
          responseId: "r1",
        }),
      ]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "gemini",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      const candidate = (obj.candidates as Array<Record<string, unknown>>)[0];
      const parts = (candidate.content as Record<string, unknown>).parts as Array<
        Record<string, unknown>
      >;
      expect(parts[0]?.text).toBe("hello");
      expect(candidate.finishReason).toBe("STOP");
      expect(obj.modelVersion).toBe("gemini-1.5-pro");
      expect(obj.responseId).toBe("r1");
      expect((obj.usageMetadata as Record<string, number>).totalTokenCount).toBe(5);
    });

    test("synthesizes GeminiResponse from text fragments + metadata when only fragments present", () => {
      const body = dataOnlySse([
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "hel" }] },
            },
          ],
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

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "gemini",
      });

      expect(out).not.toBeNull();
      const obj = out as Record<string, unknown>;
      const candidate = (obj.candidates as Array<Record<string, unknown>>)[0];
      const parts = (candidate.content as Record<string, unknown>).parts as Array<
        Record<string, unknown>
      >;
      // Merged text parts.
      expect(parts.map((p) => p.text).join("")).toBe("hello");
      expect(candidate.finishReason).toBe("STOP");
      expect(obj.modelVersion).toBe("gemini-1.5-pro");
      expect(obj.responseId).toBe("r2");
    });

    test("refuses normalization for fragment stream without any candidates", () => {
      const body = dataOnlySse([JSON.stringify({ usageMetadata: { totalTokenCount: 1 } })]);

      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "gemini",
      });

      expect(out).toBeNull();
    });
  });

  describe("unknown family / empty body", () => {
    test("returns null for unknown family", () => {
      const body = sse([["something", '{"a":1}']]);
      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "unknown-family",
      });
      expect(out).toBeNull();
    });

    test("returns null for empty body", () => {
      const out = normalizeLangfuseStreamingOutput({
        body: "",
        family: "responses",
      });
      expect(out).toBeNull();
    });

    test("returns null when family does not match the actual stream payload", () => {
      // Anthropic payload passed through with family=gemini.
      const body = sse([
        ["message_start", JSON.stringify({ type: "message_start", message: { id: "m" } })],
      ]);
      const out = normalizeLangfuseStreamingOutput({
        body,
        family: "gemini",
      });
      expect(out).toBeNull();
    });
  });

  describe("normalizeStreamOutput (positional adapter)", () => {
    test("maps responses-codex family to internal responses family and returns merged object", () => {
      const body = sse([
        [
          "response.completed",
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_adapter",
              object: "response",
              created: 9,
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  id: "m",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "adapter" }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
        ],
      ]);

      const out = normalizeStreamOutput(body, "responses-codex");

      expect(out).not.toBeNull();
      expect((out as { id?: string }).id).toBe("resp_adapter");
      expect((out as { status?: string }).status).toBe("completed");
    });

    test("returns null for empty body via the positional adapter", () => {
      expect(normalizeStreamOutput("", "anthropic")).toBeNull();
    });
  });
});
