import { describe, expect, test } from "vitest";
import { applyBodyOps } from "@/app/v1/_lib/edge/body-ops";
import { diffTopLevelOps } from "@/app/v1/_lib/edge/step-builder";

const BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  thinking: { type: "enabled", budget_tokens: 2048 },
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90" },
    { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
  ],
  messages: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", signature: "sig" },
        { type: "text", text: "a", signature: "stray" },
        { type: "tool_use", id: "tu", name: "x", input: {} },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
  ],
  _private: { a: 1 },
};

describe("applyBodyOps", () => {
  test("does not mutate the original body", () => {
    const original = structuredClone(BODY);
    applyBodyOps(original, [
      { op: "set_top_level", key: "model", value: "m2" },
      { op: "remove_system_billing_header" },
      { op: "strip_private_params" },
    ]);
    expect(original).toEqual(BODY);
  });

  test("set and delete top-level fields keep key order for existing keys", () => {
    const { message } = applyBodyOps(BODY, [
      { op: "set_top_level", key: "model", value: "claude-x" },
      { op: "delete_top_level", key: "thinking" },
      { op: "set_top_level", key: "metadata", value: { user_id: "u" } },
    ]);
    expect(Object.keys(message)).toEqual([
      "model",
      "max_tokens",
      "system",
      "messages",
      "_private",
      "metadata",
    ]);
    expect(message.model).toBe("claude-x");
  });

  test("billing header removal reports removed values", () => {
    const { message, opResults } = applyBodyOps(BODY, [{ op: "remove_system_billing_header" }]);
    expect(message.system).toHaveLength(1);
    expect(opResults.billingHeader).toEqual({
      removedCount: 1,
      extractedValues: ["x-anthropic-billing-header: cc_version=2.1.90"],
    });
    expect(
      applyBodyOps({ system: "plain" }, [{ op: "remove_system_billing_header" }]).opResults
    ).toEqual({});
  });

  test("cache TTL override applies to system and message blocks", () => {
    const { message } = applyBodyOps(BODY, [{ op: "set_cache_control_ttl", ttl: "1h" }]);
    const system = message.system as Array<{ cache_control?: { ttl?: string } }>;
    expect(system[1].cache_control?.ttl).toBe("1h");
    const messages = message.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
    expect(messages[1].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("thinking signature rectifier strips thinking blocks and reports top-level removal", () => {
    const { message, opResults } = applyBodyOps(BODY, [
      { op: "apply_thinking_signature_rectifier" },
    ]);
    const content = (message.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    expect(content.map((block) => block.type)).toEqual(["text", "tool_use"]);
    expect(content[0].signature).toBeUndefined();
    expect(message.thinking).toBeUndefined();
    expect(opResults.thinkingSignature).toEqual({
      applied: true,
      removedThinkingBlocks: 1,
      removedRedactedThinkingBlocks: 0,
      removedSignatureFields: 1,
      removedTopLevelThinking: true,
    });
  });

  test("private parameters are removed recursively", () => {
    const { message } = applyBodyOps({ a: 1, _b: 2, nested: [{ _c: 3, d: 4 }] }, [
      { op: "strip_private_params" },
    ]);
    expect(message).toEqual({ a: 1, nested: [{ d: 4 }] });
  });
});

describe("diffTopLevelOps", () => {
  test("emits set, delete and no-op entries relative to the original", () => {
    const ops = diffTopLevelOps(
      { model: "a", max_tokens: 1, thinking: { type: "enabled" }, stream: true },
      { model: "b", max_tokens: 1, output_config: { effort: "high" }, stream: false }
    );
    expect(ops).toEqual([
      { op: "set_top_level", key: "model", value: "b" },
      { op: "delete_top_level", key: "thinking" },
      { op: "set_top_level", key: "output_config", value: { effort: "high" } },
    ]);
  });
});
