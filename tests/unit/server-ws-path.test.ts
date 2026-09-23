import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const requireFromHere = createRequire(import.meta.url);

type ServerJsModule = {
  isResponsesWsUpgrade: (req: { url?: string }, listenPrefixes?: readonly string[]) => boolean;
};

const { isResponsesWsUpgrade } = requireFromHere("../../server.js") as ServerJsModule;

describe("isResponsesWsUpgrade", () => {
  test.each(["/v1/responses", "/v1/responses/", "/responses", "/responses/?model=gpt"])(
    "accepts %s",
    (url) => {
      expect(isResponsesWsUpgrade({ url })).toBe(true);
    }
  );

  test.each(["/v1/messages", "/v1/chat/completions", "/models", "/dashboard", "/"])(
    "rejects %s",
    (url) => {
      expect(isResponsesWsUpgrade({ url })).toBe(false);
    }
  );

  test("rejects missing url", () => {
    expect(isResponsesWsUpgrade({})).toBe(false);
  });
});

describe("isResponsesWsUpgrade with PROXY_LISTEN_PREFIX", () => {
  const prefixes = ["/gw"];

  test.each([
    "/gw/v1/responses",
    "/gw/v1/responses/",
    "/gw/responses",
    "/gw/responses/?model=gpt",
    "/v1/responses",
    "/responses",
  ])("accepts %s", (url) => {
    expect(isResponsesWsUpgrade({ url }, prefixes)).toBe(true);
  });

  test.each([
    "/gw/v1/messages",
    "/gw/models",
    "/gw",
    "/gwx/v1/responses",
    "/gw/v1/responses/extra",
  ])("rejects %s", (url) => {
    expect(isResponsesWsUpgrade({ url }, prefixes)).toBe(false);
  });

  test("rejects prefixed paths when no prefix is configured", () => {
    expect(isResponsesWsUpgrade({ url: "/gw/v1/responses" })).toBe(false);
  });
});
