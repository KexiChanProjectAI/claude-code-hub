import { describe, expect, it } from "vitest";
import {
  extractOpenRouterUpstreamProvider,
  isOpenRouterProvider,
  withOpenRouterUpstreamProvider,
} from "@/app/v1/_lib/proxy/openrouter-upstream-provider";
import { getOpenRouterUpstreamProviderSpecialSetting } from "@/lib/utils/special-settings";
import type { SpecialSetting } from "@/types/special-settings";

describe("isOpenRouterProvider", () => {
  it("matches openrouter.ai hosts", () => {
    expect(isOpenRouterProvider({ url: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(isOpenRouterProvider({ url: "https://eu.openrouter.ai/api" })).toBe(true);
    expect(isOpenRouterProvider({ url: "https://OpenRouter.ai/api" })).toBe(true);
  });

  it("does not match lookalike or unrelated hosts", () => {
    expect(isOpenRouterProvider({ url: "https://openrouter.ai.evil.com" })).toBe(false);
    expect(isOpenRouterProvider({ url: "https://api.openai.com/v1" })).toBe(false);
    expect(isOpenRouterProvider({ url: "not a url" })).toBe(false);
    expect(isOpenRouterProvider({ url: null })).toBe(false);
    expect(isOpenRouterProvider(null)).toBe(false);
  });

  it("matches a proxied OpenRouter when routing is configured", () => {
    expect(
      isOpenRouterProvider({
        url: "https://gateway.example.com/openrouter",
        providerType: "openai-compatible",
        openrouterProviderRouting: { zdr: true },
      })
    ).toBe(true);
  });
});

describe("extractOpenRouterUpstreamProvider", () => {
  it("reads a chat completion JSON body", () => {
    const body = JSON.stringify({
      id: "gen-123",
      provider: "DeepInfra",
      model: "deepseek/deepseek-chat",
      object: "chat.completion",
      choices: [],
    });
    expect(extractOpenRouterUpstreamProvider(body)).toEqual({
      upstreamProvider: "DeepInfra",
      generationId: "gen-123",
    });
  });

  it("reads the first SSE chunk carrying provider", () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      "",
      'data: {"id":"gen-abc","provider":"Together","choices":[{"delta":{"content":"Hi"}}]}',
      "",
      'data: {"id":"gen-abc","provider":"Together","choices":[]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(extractOpenRouterUpstreamProvider(sse)).toEqual({
      upstreamProvider: "Together",
      generationId: "gen-abc",
    });
  });

  it("reads Anthropic message_start and Responses envelopes", () => {
    const anthropic = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"gen-m1","provider":"Anthropic","model":"claude"}}',
      "",
    ].join("\n");
    expect(extractOpenRouterUpstreamProvider(anthropic)).toEqual({
      upstreamProvider: "Anthropic",
      generationId: "gen-m1",
    });

    const responses = JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", provider: "OpenAI" },
    });
    expect(extractOpenRouterUpstreamProvider(responses)).toEqual({
      upstreamProvider: "OpenAI",
      generationId: null,
    });
  });

  it("ignores non-string provider values and malformed input", () => {
    expect(extractOpenRouterUpstreamProvider(JSON.stringify({ provider: { sort: "price" } }))).toBe(
      null
    );
    expect(extractOpenRouterUpstreamProvider(JSON.stringify({ provider: "   " }))).toBeNull();
    expect(extractOpenRouterUpstreamProvider("{not json")).toBeNull();
    expect(extractOpenRouterUpstreamProvider("")).toBeNull();
    expect(extractOpenRouterUpstreamProvider(null)).toBeNull();
  });

  it("caps very long provider names", () => {
    const result = extractOpenRouterUpstreamProvider(JSON.stringify({ provider: "x".repeat(500) }));
    expect(result?.upstreamProvider).toHaveLength(128);
  });
});

function createSession(provider: Record<string, unknown> | null) {
  const settings: SpecialSetting[] = [];
  return {
    provider,
    settings,
    addSpecialSetting(setting: SpecialSetting) {
      settings.push(setting);
    },
    getSpecialSettings() {
      return settings.length > 0 ? settings : null;
    },
  };
}

describe("withOpenRouterUpstreamProvider", () => {
  const body = JSON.stringify({ id: "gen-9", provider: "Fireworks" });

  it("records the special setting for OpenRouter providers", () => {
    const session = createSession({ url: "https://openrouter.ai/api/v1" });
    const result = withOpenRouterUpstreamProvider(session, body);
    expect(result).toEqual([
      {
        type: "openrouter_upstream_provider",
        scope: "response",
        hit: true,
        upstreamProvider: "Fireworks",
        generationId: "gen-9",
      },
    ]);
    expect(getOpenRouterUpstreamProviderSpecialSetting(result)?.upstreamProvider).toBe("Fireworks");
  });

  it("does nothing for other providers", () => {
    const session = createSession({ url: "https://api.openai.com/v1" });
    expect(withOpenRouterUpstreamProvider(session, body)).toBeUndefined();
    expect(session.settings).toHaveLength(0);
  });

  it("returns existing settings when nothing is extracted", () => {
    const session = createSession({ url: "https://openrouter.ai/api/v1" });
    session.addSpecialSetting({
      type: "billing_header_rectifier",
      scope: "request",
      hit: true,
      removedCount: 1,
      extractedValues: [],
    });
    expect(withOpenRouterUpstreamProvider(session, "{}")).toHaveLength(1);
  });
});

describe("getOpenRouterUpstreamProviderSpecialSetting", () => {
  it("returns null for empty input", () => {
    expect(getOpenRouterUpstreamProviderSpecialSetting(null)).toBeNull();
    expect(getOpenRouterUpstreamProviderSpecialSetting([])).toBeNull();
  });
});
