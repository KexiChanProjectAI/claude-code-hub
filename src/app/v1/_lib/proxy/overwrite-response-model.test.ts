import { describe, expect, test } from "vitest";
import {
  overwriteClientFacingStream,
  overwriteResponseModelFields,
  overwriteResponseModelInStreamText,
  overwriteResponseModelInText,
  shouldOverwriteResponseModel,
} from "./overwrite-response-model";

describe("shouldOverwriteResponseModel", () => {
  test("requires both the flag and a requested model", () => {
    expect(shouldOverwriteResponseModel(true, "claude-sonnet-4-5")).toBe(true);
    expect(shouldOverwriteResponseModel(false, "claude-sonnet-4-5")).toBe(false);
    expect(shouldOverwriteResponseModel(true, "")).toBe(false);
    expect(shouldOverwriteResponseModel(true, null)).toBe(false);
  });
});

describe("overwriteResponseModelFields", () => {
  test("rewrites known model fields and leaves other keys", () => {
    const openai = { id: "chatcmpl-1", model: "glm-4.7", choices: [] };
    expect(overwriteResponseModelFields(openai, "claude-sonnet-4-5")).toBe(true);
    expect(openai.model).toBe("claude-sonnet-4-5");

    const anthropic = {
      type: "message_start",
      message: { type: "message", model: "glm-4.7", id: "msg_1" },
    };
    expect(overwriteResponseModelFields(anthropic, "claude-sonnet-4-5")).toBe(true);
    expect(anthropic.message.model).toBe("claude-sonnet-4-5");

    const responses = {
      type: "response.created",
      response: { id: "resp_1", model: "gpt-5.6-luna" },
    };
    expect(overwriteResponseModelFields(responses, "gpt-5.5")).toBe(true);
    expect(responses.response.model).toBe("gpt-5.5");

    const gemini = { modelVersion: "minimax-m2.7", candidates: [] };
    expect(overwriteResponseModelFields(gemini, "claude-sonnet-4-5")).toBe(true);
    expect(gemini.modelVersion).toBe("claude-sonnet-4-5");
  });

  test("does not invent model fields or rewrite nested content", () => {
    const chunk = { choices: [{ delta: { content: "model: secret" } }] };
    expect(overwriteResponseModelFields(chunk, "claude-sonnet-4-5")).toBe(false);
    expect(chunk).toEqual({ choices: [{ delta: { content: "model: secret" } }] });
  });
});

describe("overwriteResponseModelInText", () => {
  test("rewrites JSON bodies and SSE frames", () => {
    expect(
      overwriteResponseModelInText(
        JSON.stringify({ model: "glm-4.7", id: "1" }),
        "claude-sonnet-4-5"
      )
    ).toBe(JSON.stringify({ model: "claude-sonnet-4-5", id: "1" }));

    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"model":"glm-4.7"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(overwriteResponseModelInStreamText(sse, "claude-sonnet-4-5")).toContain(
      '"model":"claude-sonnet-4-5"'
    );
    expect(overwriteResponseModelInStreamText(sse, "claude-sonnet-4-5")).toContain("data: [DONE]");
  });
});

describe("overwriteClientFacingStream", () => {
  test("rewrites SSE model fields across chunk boundaries", async () => {
    const sse = 'data: {"model":"glm-4.7","id":"1"}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(sse);
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });
    const rewritten = overwriteClientFacingStream(true, "claude-sonnet-4-5", stream);
    const text = await new Response(rewritten).text();
    expect(text).toContain('"model":"claude-sonnet-4-5"');
    expect(text).toContain('"id":"1"');
  });

  test("leaves the stream untouched when the flag is off", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"model":"glm-4.7"}\n\n'));
        controller.close();
      },
    });
    const rewritten = overwriteClientFacingStream(false, "claude-sonnet-4-5", stream);
    expect(await new Response(rewritten).text()).toBe('data: {"model":"glm-4.7"}\n\n');
  });
});
