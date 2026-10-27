import { describe, expect, it } from "vitest";
import { extractRequestMessages } from "./session-detail-snapshots";

describe("extractRequestMessages", () => {
  it("follows ProxySession.getMessages precedence", () => {
    const messages = [{ role: "user", content: "a" }];
    expect(extractRequestMessages({ messages, input: [1] })).toBe(messages);
    expect(extractRequestMessages({ input: messages, contents: [1] })).toBe(messages);
    expect(extractRequestMessages({ contents: messages })).toBe(messages);
    expect(extractRequestMessages({ request: { contents: messages } })).toBe(messages);
  });

  it("returns null when the body carries no conversation", () => {
    expect(extractRequestMessages(null)).toBeNull();
    expect(extractRequestMessages([1, 2])).toBeNull();
    expect(extractRequestMessages("text")).toBeNull();
    expect(extractRequestMessages({ model: "x" })).toBeNull();
    expect(extractRequestMessages({ request: "x" })).toBeNull();
    expect(extractRequestMessages({ request: {} })).toBeNull();
  });
});
