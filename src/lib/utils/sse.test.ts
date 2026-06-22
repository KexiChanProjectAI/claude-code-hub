import { describe, expect, test } from "vitest";
import { isSSEText, parseSSEData, parseSSEDataForDisplay } from "./sse";

describe("sse utils", () => {
  test("isSSEText detects standard SSE by line prefixes", () => {
    expect(
      isSSEText(
        [
          "event: content_block_delta",
          'data: {"type":"content_block_delta"}',
          "",
          "data: [DONE]",
        ].join("\n")
      )
    ).toBe(true);
    expect(isSSEText('{"data":123}')).toBe(false);
    expect(isSSEText("not sse\ndata: nope")).toBe(false);
    expect(isSSEText("")).toBe(false);
    expect(isSSEText([": keep-alive", "data: 1"].join("\n"))).toBe(true);
  });

  test("parseSSEDataForDisplay parses and drops [DONE]", () => {
    const events = parseSSEDataForDisplay(
      [
        "event: message",
        'data: {"a":1}',
        "",
        "event: message",
        "data: hello",
        "",
        "data: [DONE]",
      ].join("\n")
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: "message", data: { a: 1 } });
    expect(events[1]).toEqual({ event: "message", data: "hello" });
  });

  test("parseSSEData strips the leading single space after data:", () => {
    const events = parseSSEData(["event: e", "data: 1", ""].join("\n"));
    expect(events).toEqual([{ event: "e", data: 1 }]);
  });

  test("parseSSEData keeps data value when there is no space after data:", () => {
    const events = parseSSEData(["event: e", "data:1", ""].join("\n"));
    expect(events).toEqual([{ event: "e", data: 1 }]);
  });

  test("parseSSEData ignores unsupported SSE fields (e.g. id:)", () => {
    const events = parseSSEData(["id: 1", "data: 1", ""].join("\n"));
    expect(events).toEqual([{ event: "message", data: 1 }]);
  });

  test("parseSSEDataForDisplay supports data-only events and multi-line JSON", () => {
    const events = parseSSEDataForDisplay(["data: {", 'data: "k": 1', "data: }", ""].join("\n"));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("message");
    expect(events[0]?.data).toEqual({ k: 1 });
  });

  test("parseSSEDataForDisplay ignores comments and flushes on blank line", () => {
    const events = parseSSEDataForDisplay(
      [": keep-alive", "event: e", "data: 1", "", ""].join("\n")
    );
    expect(events).toEqual([{ event: "e", data: 1 }]);
  });

  // Baseline characterization coverage for runtime SSE primitives that the
  // Langfuse streaming-output normalizer depends on. These tests lock the
  // exact parsing behavior of parseSSEData on real Codex/Anthropic/OpenAI/Gemini
  // fixtures so that any future change to parseSSEData is detected before the
  // normalizer regresses.
  test("parseSSEData characterizes Responses/Codex SSE event stream", () => {
    const body = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"po"}',
      "",
      "event: response.output_text.done",
      'data: {"type":"response.output_text.done","text":"pong"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}',
      "",
    ].join("\n");
    const events = parseSSEData(body);
    expect(events).toHaveLength(3);
    expect(events[0]?.event).toBe("response.output_text.delta");
    expect(events[0]?.data).toEqual({
      type: "response.output_text.delta",
      delta: "po",
    });
    expect(events[1]?.event).toBe("response.output_text.done");
    expect(events[1]?.data).toEqual({
      type: "response.output_text.done",
      text: "pong",
    });
    expect(events[2]?.event).toBe("response.completed");
    expect((events[2]?.data as { response?: { id?: string } }).response?.id).toBe("r1");
  });

  test("parseSSEData characterizes Anthropic message stream events", () => {
    const body = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"m1","role":"assistant"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const events = parseSSEData(body);
    expect(events).toHaveLength(3);
    expect(events[0]?.event).toBe("message_start");
    expect(events[1]?.event).toBe("content_block_delta");
    const delta = (events[1]?.data as { delta?: { text?: string } }).delta;
    expect(delta?.text).toBe("hi");
    expect(events[2]?.event).toBe("message_stop");
  });

  test("parseSSEData characterizes data-only NDJSON-shaped Gemini stream", () => {
    // Gemini passthrough often uses data: only (no event:) lines.
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":5}}',
      "",
    ].join("\n");
    const events = parseSSEData(body);
    expect(events).toHaveLength(2);
    // No event: prefix -> default "message" event name.
    expect(events.every((e) => e.event === "message")).toBe(true);
    expect(
      (events[1]?.data as { candidates?: Array<{ finishReason?: string }> }).candidates?.[0]
        ?.finishReason
    ).toBe("STOP");
  });
});
