import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/provider-cache", () => ({
  getProviderCacheStats: () => ({ version: 3 }),
}));

import { attachModelsEtag, MODELS_ETAG_HEADER } from "@/app/v1/_lib/proxy/models-etag";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import {
  buildCodexCatalogCacheKey,
  getOrBuildCodexCatalog,
  resetCodexCatalogCacheForTests,
} from "@/lib/codex-catalog/cache";

const user = { id: 1, providerGroup: "g", allowedModels: ["gpt-6.1-sol"] };
const key = { providerGroup: null };

function session(format = "response", withAuth = true): ProxySession {
  return {
    originalFormat: format,
    authState: withAuth ? { user, key, apiKey: "sk", success: true } : null,
  } as unknown as ProxySession;
}

async function primeCatalog(etag: string) {
  await getOrBuildCodexCatalog(buildCodexCatalogCacheKey({ user, key }), async () => ({
    body: "{}",
    etag,
    modelCount: 0,
  }));
}

describe("attachModelsEtag", () => {
  beforeEach(() => resetCodexCatalogCacheForTests());

  it("adds the cached catalog ETag byte for byte", async () => {
    await primeCatalog('"cch-codex-abc"');
    const original = new Response("ok", { status: 201, statusText: "Created" });
    const result = attachModelsEtag(session(), original);
    expect(result.headers.get(MODELS_ETAG_HEADER)).toBe('"cch-codex-abc"');
    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(await result.text()).toBe("ok");
  });

  it("passes streaming bodies through untouched", async () => {
    await primeCatalog('"e"');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
        controller.close();
      },
    });
    const original = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const result = attachModelsEtag(session(), original);
    expect(result.body).toBe(stream);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toBe("data: 1\n\n");
  });

  it("overrides an upstream X-Models-Etag with ours", async () => {
    await primeCatalog('"ours"');
    const original = new Response("x", { headers: { [MODELS_ETAG_HEADER]: '"upstream"' } });
    expect(attachModelsEtag(session(), original).headers.get(MODELS_ETAG_HEADER)).toBe('"ours"');
  });

  it("keeps the response object when it already carries our ETag", async () => {
    await primeCatalog('"ours"');
    const original = new Response("x", { headers: { [MODELS_ETAG_HEADER]: '"ours"' } });
    expect(attachModelsEtag(session(), original)).toBe(original);
  });

  it("strips an upstream X-Models-Etag when no catalog is cached", () => {
    const original = new Response("x", { headers: { [MODELS_ETAG_HEADER]: '"upstream"' } });
    expect(attachModelsEtag(session(), original).headers.has(MODELS_ETAG_HEADER)).toBe(false);
  });

  it("does nothing when no catalog is cached", () => {
    const original = new Response("x");
    expect(attachModelsEtag(session(), original)).toBe(original);
  });

  it("does nothing for non-Responses formats or unauthenticated sessions", async () => {
    await primeCatalog('"e"');
    const original = new Response("x", { headers: { [MODELS_ETAG_HEADER]: '"upstream"' } });
    expect(attachModelsEtag(session("claude"), original)).toBe(original);
    expect(attachModelsEtag(session("openai"), original)).toBe(original);
    const noAuth = new Response("x");
    expect(attachModelsEtag(session("response", false), noAuth)).toBe(noAuth);
  });

  it("keeps the original response when it cannot be rewrapped", async () => {
    await primeCatalog('"e"');
    const original = new Response("x");
    await original.text();
    const result = attachModelsEtag(session(), original);
    expect(result.status).toBe(200);
  });
});
