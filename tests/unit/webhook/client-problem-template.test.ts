import { afterEach, describe, expect, it } from "vitest";
import { resolveWebhookProxyUrl } from "@/lib/webhook/env-proxy";
import { buildClientProblemMessage } from "@/lib/webhook/templates/client-problem";
import { applyNotificationTitlePrefix } from "@/lib/webhook/title-prefix";
import type { ClientProblemAlertData } from "@/lib/webhook/types";

function emojiLike(value: string): boolean {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(value);
}

function generalPayload(overrides: Partial<ClientProblemAlertData> = {}): ClientProblemAlertData {
  return {
    bucket: "general",
    kindCounts: { timeout: 1, server: 2, cyber: 0 },
    totalCount: 3,
    windowStartedAt: "2026-09-09T10:00:00.000Z",
    windowMinutes: 5,
    trigger: "count",
    byStatus: [
      { key: "502", count: 2 },
      { key: "524", count: 1 },
    ],
    byUser: [{ key: "1:alice", count: 3 }],
    byProvider: [{ key: "5:opus-pool", count: 3 }],
    byModel: [{ key: "claude-sonnet-4", count: 3 }],
    samples: [
      {
        at: "2026-09-09T10:00:01.000Z",
        userName: "alice",
        providerName: "opus-pool",
        model: "claude-sonnet-4",
        statusCode: 524,
        kind: "timeout",
        error: "STREAM_IDLE_TIMEOUT",
      },
    ],
    ...overrides,
  };
}

describe("buildClientProblemMessage", () => {
  it("renders general titles without emoji", () => {
    const message = buildClientProblemMessage(generalPayload(), "UTC");
    expect(message.header.title).toBe("客户端故障汇总");
    expect(message.header.icon).toBe("[ERR]");
    expect(message.header.level).toBe("error");
    const serialized = JSON.stringify(message);
    expect(serialized).toContain("STREAM_IDLE_TIMEOUT");
    expect(serialized).not.toContain("499");
    expect(emojiLike(serialized)).toBe(false);
  });

  it("renders cyber titles", () => {
    const message = buildClientProblemMessage(
      generalPayload({
        bucket: "cyber",
        kindCounts: { timeout: 0, server: 0, cyber: 2 },
        totalCount: 2,
        trigger: "window",
      }),
      "UTC"
    );
    expect(message.header.title).toContain("Cyber risk");
    expect(message.header.icon).toBe("[CYBER]");
    const serialized = JSON.stringify(message);
    expect(serialized).toContain("Cyber risk");
    expect(serialized).not.toContain("499");
    expect(emojiLike(serialized)).toBe(false);
  });
});

describe("applyNotificationTitlePrefix", () => {
  it("prefixes titles so PROXY instances are distinguishable", () => {
    const message = buildClientProblemMessage(generalPayload(), "UTC");
    const prefixed = applyNotificationTitlePrefix(message, "PROXY");
    expect(prefixed.header.title).toBe("[PROXY] 客户端故障汇总");
    expect(applyNotificationTitlePrefix(prefixed, "PROXY").header.title).toBe(
      "[PROXY] 客户端故障汇总"
    );
  });
});

describe("resolveWebhookProxyUrl", () => {
  const previousProxy = process.env.PROXY;

  afterEach(() => {
    if (previousProxy === undefined) delete process.env.PROXY;
    else process.env.PROXY = previousProxy;
  });

  it("prefers configured proxyUrl over PROXY env", () => {
    process.env.PROXY = "http://env-proxy:8080";
    expect(resolveWebhookProxyUrl("http://target-proxy:3128")).toBe("http://target-proxy:3128");
  });

  it("falls back to PROXY env when target has no proxy", () => {
    process.env.PROXY = "http://env-proxy:8080";
    expect(resolveWebhookProxyUrl(null)).toBe("http://env-proxy:8080");
  });
});
