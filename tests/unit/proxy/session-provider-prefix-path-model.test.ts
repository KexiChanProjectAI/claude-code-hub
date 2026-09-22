import { Context } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

const mocks = vi.hoisted(() => ({
  findAllProviders: vi.fn<() => Promise<Provider[]>>(),
}));

vi.mock("@/repository/provider", () => ({
  findAllProviders: mocks.findAllProviders,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ProxySession } from "@/app/v1/_lib/proxy/session";

async function createGeminiSession(pathname: string, body: Record<string, unknown> = {}) {
  const request = new Request(`https://hub.test${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], ...body }),
  });
  return ProxySession.fromContext(new Context(request));
}

function providers(...prefixes: Array<string | null>): Provider[] {
  return prefixes.map((providerPrefix, index) => ({ id: index + 1, providerPrefix }) as Provider);
}

describe("ProxySession.fromContext - prefixed Gemini path models", () => {
  beforeEach(() => {
    mocks.findAllProviders.mockResolvedValue([]);
  });

  test("does not load providers for ordinary Gemini paths", async () => {
    const session = await createGeminiSession("/v1beta/models/gemini-2.5-flash:generateContent");

    expect(session.request.model).toBe("gemini-2.5-flash");
    expect(mocks.findAllProviders).not.toHaveBeenCalled();
  });

  test("keeps the legacy model when no provider has a prefix", async () => {
    mocks.findAllProviders.mockResolvedValue(providers(null, null));

    const session = await createGeminiSession(
      "/v1beta/models/google/gemini-2.5-flash:generateContent"
    );

    expect(session.request.model).toBe("google");
    expect(session.getRawIntakeModel()).toBe("google");
  });

  test("keeps the legacy model for an operations path", async () => {
    mocks.findAllProviders.mockResolvedValue(providers("google/"));

    const session = await createGeminiSession("/v1beta/models/veo-3.0/operations/abc123");

    expect(session.request.model).toBe("veo-3.0");
  });

  test("uses the full prefixed model when a provider has that prefix", async () => {
    mocks.findAllProviders.mockResolvedValue(providers(null, "google/"));

    const session = await createGeminiSession(
      "/v1beta/models/google/gemini-2.5-flash:generateContent"
    );

    expect(session.request.model).toBe("google/gemini-2.5-flash");
    expect(session.getRawIntakeModel()).toBe("google/gemini-2.5-flash");
  });

  test("falls back to the legacy model when loading providers fails", async () => {
    mocks.findAllProviders.mockRejectedValue(new Error("db down"));

    const session = await createGeminiSession(
      "/v1beta/models/google/gemini-2.5-flash:generateContent"
    );

    expect(session.request.model).toBe("google");
  });

  test("prefers the body model and skips the provider lookup", async () => {
    mocks.findAllProviders.mockResolvedValue(providers("google/"));

    const session = await createGeminiSession(
      "/v1beta/models/google/gemini-2.5-flash:generateContent",
      { model: "body-model" }
    );

    expect(session.request.model).toBe("body-model");
    expect(mocks.findAllProviders).not.toHaveBeenCalled();
  });
});
