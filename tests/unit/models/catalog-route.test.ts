import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  auth: vi.fn(),
  getLocale: vi.fn(),
}));

vi.mock("@/lib/model-catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/model-catalog/render-markdown")>(
    "@/lib/model-catalog/render-markdown"
  );
  return { buildModelCatalog: mocks.build, renderCatalogMarkdown: actual.renderCatalogMarkdown };
});
vi.mock("@/app/v1/_lib/models/authenticate-request", () => ({
  authenticateApiKeyRequest: mocks.auth,
}));
vi.mock("next-intl/server", () => ({ getLocale: mocks.getLocale }));

import { Hono } from "hono";
import { handleModelCatalog, negotiateCatalogFormat } from "@/app/v1/_lib/catalog/handle-catalog";
import { mapUnprefixedV1Path } from "@/app/v1/_lib/unprefixed-v1-alias";
import { ModelCatalogSchema } from "@/lib/model-catalog/schema";
import type { ModelCatalog } from "@/lib/model-catalog/types";

const CATALOG: ModelCatalog = {
  generatedAt: "2026-10-07T00:00:00.000Z",
  models: [
    {
      id: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      vendor: "anthropic",
      vendorName: "Anthropic",
      vendorIcon: null,
      vendorIconMono: false,
      protocols: ["claude"],
      contextWindow: 200000,
      maxOutputTokens: 64000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: {
        vision: true,
        functionCalling: true,
        reasoning: true,
        pdfInput: true,
        promptCaching: true,
      },
      modalities: { input: ["text"], output: ["text"] },
      knowledgeCutoff: null,
      deprecated: false,
      hasPriceData: true,
    },
  ],
  protocols: [
    {
      id: "claude",
      label: "Anthropic Messages API",
      endpointPath: "/v1/messages",
      models: ["claude-sonnet-4-5"],
    },
  ],
  notes: "Use Sonnet.",
};

function app() {
  const hono = new Hono().basePath("/v1");
  hono.get("/models/catalog", handleModelCatalog);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.build.mockResolvedValue(CATALOG);
  mocks.auth.mockResolvedValue({
    user: { id: 1, providerGroup: null, isEnabled: true, allowedModels: [] },
    key: { providerGroup: "vip", name: "k" },
  });
  mocks.getLocale.mockResolvedValue("en");
});

describe("negotiateCatalogFormat", () => {
  it("lets ?format override Accept", () => {
    expect(negotiateCatalogFormat({ formatQuery: "md", accept: "text/html" })).toBe("markdown");
    expect(negotiateCatalogFormat({ formatQuery: "Markdown" })).toBe("markdown");
    expect(negotiateCatalogFormat({ formatQuery: "json", accept: "text/markdown" })).toBe("json");
    expect(negotiateCatalogFormat({ formatQuery: "html" })).toBe("html");
  });

  it("falls back to Accept and then JSON", () => {
    expect(negotiateCatalogFormat({ accept: "text/html,application/xhtml+xml" })).toBe("html");
    expect(negotiateCatalogFormat({ accept: "text/markdown" })).toBe("markdown");
    expect(negotiateCatalogFormat({ accept: "text/plain" })).toBe("markdown");
    expect(negotiateCatalogFormat({ accept: "*/*" })).toBe("json");
    expect(negotiateCatalogFormat({ formatQuery: "xml" })).toBe("json");
    expect(negotiateCatalogFormat({})).toBe("json");
  });
});

describe("GET /v1/models/catalog", () => {
  it("returns schema-valid JSON by default with no-store caching", async () => {
    const res = await app().request("/v1/models/catalog", {
      headers: { authorization: "Bearer sk-1", accept: "*/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Accept");
    const body = await res.json();
    expect(ModelCatalogSchema.parse(body)).toEqual(CATALOG);
    expect(mocks.build).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 1 }),
      key: expect.objectContaining({ providerGroup: "vip" }),
    });
  });

  it("returns Markdown with the forwarded base URL", async () => {
    const res = await app().request("http://internal:13500/v1/models/catalog?format=md", {
      headers: {
        authorization: "Bearer sk-1",
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "hub.example.com",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# Model Catalog");
    expect(text).toContain("Base URL: https://hub.example.com");
    expect(text).toContain("Use Sonnet.");
  });

  it("uses the request origin when no forwarded headers are present", async () => {
    const res = await app().request("http://localhost:13500/v1/models/catalog", {
      headers: { accept: "text/markdown", "x-forwarded-proto": "gopher" },
    });
    expect(await res.text()).toContain("Base URL: http://localhost:13500");
  });

  it("redirects browsers to the localized page before authenticating", async () => {
    const res = await app().request("/v1/models/catalog", {
      headers: { accept: "text/html,*/*" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/en/models");
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("falls back to the default locale when next-intl is unavailable", async () => {
    mocks.getLocale.mockRejectedValue(new Error("no request scope"));
    const res = await app().request("/v1/models/catalog?format=html");
    expect(res.headers.get("location")).toBe("/zh-CN/models");
    mocks.getLocale.mockResolvedValue("xx");
    const unknown = await app().request("/v1/models/catalog?format=html");
    expect(unknown.headers.get("location")).toBe("/zh-CN/models");
  });

  it("passes auth failures through unchanged", async () => {
    mocks.auth.mockRejectedValue(
      new Response(JSON.stringify({ error: { type: "invalid_api_key" } }), { status: 401 })
    );
    const res = await app().request("/v1/models/catalog");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { type: "invalid_api_key" } });
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors", async () => {
    mocks.build.mockRejectedValue(new Error("boom"));
    const res = await app().request("/v1/models/catalog");
    expect(res.status).toBe(500);
  });
});

describe("unprefixed alias", () => {
  it("maps /models/catalog onto the v1 route", () => {
    expect(mapUnprefixedV1Path("/models/catalog")).toBe("/v1/models/catalog");
    expect(mapUnprefixedV1Path("/models/catalog/")).toBe("/v1/models/catalog");
  });
});
