import { describe, expect, test } from "vitest";
import { GET as chatGet, POST as chatPost } from "@/app/chat/completions/[[...route]]/route";
import { GET as anthropicGet, POST as anthropicPost } from "@/app/anthropic/[[...route]]/route";
import { GET as chatV1Get, POST as chatV1Post } from "@/app/chat/v1/[[...route]]/route";
import { GET as codexGet, POST as codexPost } from "@/app/codex/[[...route]]/route";
import { GET as messagesGet, POST as messagesPost } from "@/app/messages/[[...route]]/route";
import { GET as modelsGet, POST as modelsPost } from "@/app/models/[[...route]]/route";
import { GET as responsesGet, POST as responsesPost } from "@/app/responses/[[...route]]/route";
import { GET as v1Get, POST as v1Post, v1App } from "@/app/v1/[...route]/route";
import {
  isProtocolHint,
  mapUnprefixedV1Path,
  PROTOCOL_HINT_HEADER,
  resolveProtocolHintPath,
  rewriteUnprefixedV1Request,
} from "@/app/v1/_lib/unprefixed-v1-alias";
import { stripListenPrefix } from "@/lib/listen-prefix";

describe("mapUnprefixedV1Path", () => {
  test.each([
    ["/chat/completions", "/v1/chat/completions"],
    ["/chat/completions/", "/v1/chat/completions"],
    ["/chat/completions/models", "/v1/chat/completions/models"],
    ["/responses", "/v1/responses"],
    ["/responses/compact", "/v1/responses/compact"],
    ["/responses/models", "/v1/responses/models"],
    ["/models", "/v1/models"],
    ["/models/gpt-4.1", "/v1/models/gpt-4.1"],
    ["/messages", "/v1/messages"],
    ["/messages/count_tokens", "/v1/messages/count_tokens"],
    ["/messages/count_tokens/", "/v1/messages/count_tokens"],
    ["/codex/models", "/v1/codex/models"],
    ["/codex", "/v1/codex"],
    ["/anthropic/v1/messages", "/v1/messages"],
    ["/anthropic/v1/models", "/v1/models"],
    ["/chat/v1/chat/completions", "/v1/chat/completions"],
    ["/chat/v1/models/", "/v1/models"],
    ["/responses/v1/responses", "/v1/responses"],
    ["/responses/v1", "/v1"],
  ])("maps %s to %s", (input, expected) => {
    expect(mapUnprefixedV1Path(input)).toBe(expected);
  });

  test.each([
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/models",
    "/v1beta/models/gemini-pro:generateContent",
    "/chat",
    "/chat/completions-extra",
    "/messaging",
    "/models-archive",
    "/response",
    "/codexy",
    "/anthropic",
    "/anthropic/v2/messages",
    "/chat/v10",
    "/dashboard",
    "/",
  ])("leaves non-alias path unchanged: %s", (pathname) => {
    expect(mapUnprefixedV1Path(pathname)).toBe(pathname);
  });
});

describe("rewriteUnprefixedV1Request", () => {
  test("rewrites pathname, keeps query/method/headers/body", async () => {
    const req = new Request("http://localhost/messages/count_tokens?beta=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer k",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });

    const rewritten = rewriteUnprefixedV1Request(req);
    const url = new URL(rewritten.url);
    expect(url.pathname).toBe("/v1/messages/count_tokens");
    expect(url.search).toBe("?beta=1");
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("authorization")).toBe("Bearer k");
    expect(await rewritten.json()).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("returns the same request when path is already canonical", () => {
    const req = new Request("http://localhost/v1/messages", { method: "POST" });
    expect(rewriteUnprefixedV1Request(req)).toBe(req);
  });
});

describe("protocol-hint roots", () => {
  test.each([
    ["/anthropic/v1/messages", "/v1/messages", "claude"],
    ["/chat/v1/models", "/v1/models", "openai"],
    ["/responses/v1/responses", "/v1/responses", "response"],
  ])("%s resolves to %s with hint %s", (input, path, hint) => {
    expect(resolveProtocolHintPath(input)).toEqual({ path, hint });
  });

  test("plain aliases are not hinted", () => {
    expect(resolveProtocolHintPath("/responses/models")).toBeNull();
    expect(resolveProtocolHintPath("/chat/completions")).toBeNull();
  });

  test("isProtocolHint accepts only known hints", () => {
    expect(isProtocolHint("claude")).toBe(true);
    expect(isProtocolHint("gemini")).toBe(false);
    expect(isProtocolHint(undefined)).toBe(false);
  });

  test("rewrite sets the hint header and keeps the body", async () => {
    const req = new Request("http://localhost/anthropic/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const rewritten = rewriteUnprefixedV1Request(req);
    const url = new URL(rewritten.url);
    expect(url.pathname).toBe("/v1/messages");
    expect(url.search).toBe("?beta=true");
    expect(rewritten.headers.get(PROTOCOL_HINT_HEADER)).toBe("claude");
    expect(rewritten.headers.get("x-api-key")).toBe("k");
    expect(await rewritten.json()).toEqual({ model: "m" });
  });

  test("rewrite drops a client-sent hint header everywhere else", () => {
    const spoofed = rewriteUnprefixedV1Request(
      new Request("http://localhost/v1/models", { headers: { [PROTOCOL_HINT_HEADER]: "claude" } })
    );
    expect(spoofed.headers.has(PROTOCOL_HINT_HEADER)).toBe(false);
    expect(new URL(spoofed.url).pathname).toBe("/v1/models");

    const overridden = rewriteUnprefixedV1Request(
      new Request("http://localhost/chat/v1/models", {
        headers: { [PROTOCOL_HINT_HEADER]: "claude" },
      })
    );
    expect(overridden.headers.get(PROTOCOL_HINT_HEADER)).toBe("openai");
  });
});

describe("unprefixed alias App Router routes", () => {
  test("re-export the canonical /v1 handlers", () => {
    expect(messagesGet).toBe(v1Get);
    expect(messagesPost).toBe(v1Post);
    expect(modelsGet).toBe(v1Get);
    expect(modelsPost).toBe(v1Post);
    expect(responsesGet).toBe(v1Get);
    expect(responsesPost).toBe(v1Post);
    expect(chatGet).toBe(v1Get);
    expect(chatPost).toBe(v1Post);
    expect(codexGet).toBe(v1Get);
    expect(codexPost).toBe(v1Post);
    expect(anthropicGet).toBe(v1Get);
    expect(anthropicPost).toBe(v1Post);
    expect(chatV1Get).toBe(v1Get);
    expect(chatV1Post).toBe(v1Post);
  });
});

describe("Hono /v1 app after alias rewrite", () => {
  test("raw unprefixed /models misses basePath and 404s", async () => {
    const response = await v1App.request("/models");
    expect(response.status).toBe(404);
  });

  test("rewritten /models hits the /v1/models handler instead of 404", async () => {
    const response = await v1App.fetch(
      rewriteUnprefixedV1Request(new Request("http://localhost/models"))
    );
    expect(response.status).not.toBe(404);
  });

  test("rewritten /chat/completions hits the chat completions route", async () => {
    const raw = await v1App.request("/chat/completions", { method: "POST" });
    expect(raw.status).toBe(404);

    const rewritten = await v1App.fetch(
      rewriteUnprefixedV1Request(
        new Request("http://localhost/chat/completions", { method: "POST" })
      )
    );
    expect(rewritten.status).not.toBe(404);
  });

  test("unprefixed /codex/models reaches the Codex catalog handler (401 without a key)", async () => {
    const response = await v1Get(new Request("http://localhost/codex/models?client_version=0.0.0"));
    expect(response.status).toBe(401);
  });

  test("hinted /models reaches the models handler (401 without a key)", async () => {
    for (const path of ["/anthropic/v1/models", "/chat/v1/models", "/responses/v1/models"]) {
      const response = await v1Get(new Request(`http://localhost${path}`));
      expect(response.status, path).toBe(401);
    }
  });

  test("other /codex paths 404 instead of falling through to the proxy", async () => {
    const response = await v1Post(
      new Request("http://localhost/codex/anything", { method: "POST" })
    );
    expect(response.status).toBe(404);
  });

  test("exported GET handler rewrites unprefixed /models onto the v1 models route", async () => {
    const response = await v1Get(new Request("http://localhost/models"));
    expect(response.status).not.toBe(404);
  });

  test("exported POST handler rewrites unprefixed /messages onto the v1 messages route", async () => {
    const response = await v1Post(
      new Request("http://localhost/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );
    expect(response.status).not.toBe(404);
  });
});

describe("listen prefix composes with the unprefixed alias rewrite", () => {
  const prefixes = ["/gw"];

  test.each([
    ["/gw/models", "/v1/models"],
    ["/gw/messages", "/v1/messages"],
    ["/gw/chat/completions", "/v1/chat/completions"],
    ["/gw/v1/models", "/v1/models"],
    ["/gw/codex/models", "/v1/codex/models"],
    ["/gw/anthropic/v1/messages", "/v1/messages"],
    ["/gw/responses/v1/models", "/v1/models"],
  ])("%s canonicalizes to %s", (prefixed, expected) => {
    const stripped = stripListenPrefix(prefixed, prefixes);
    expect(stripped).not.toBeNull();
    expect(mapUnprefixedV1Path(stripped as string)).toBe(expected);
  });

  test("a prefixed unprefixed-alias request reaches the v1 handler", async () => {
    const stripped = stripListenPrefix("/gw/models", prefixes);
    const response = await v1App.fetch(
      rewriteUnprefixedV1Request(new Request(`http://localhost${stripped}`))
    );
    expect(response.status).not.toBe(404);
  });
});
