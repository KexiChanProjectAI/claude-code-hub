import { describe, expect, test } from "vitest";
import { EnvSchema } from "@/lib/config/env.schema";

describe("EnvSchema OUTBOUND_PROXY_URL", () => {
  test("is undefined when unset", () => {
    expect(EnvSchema.parse({}).OUTBOUND_PROXY_URL).toBeUndefined();
  });

  test("trims a valid http proxy", () => {
    expect(
      EnvSchema.parse({ OUTBOUND_PROXY_URL: "  http://proxy.example:8080 " }).OUTBOUND_PROXY_URL
    ).toBe("http://proxy.example:8080");
  });

  test("accepts socks5", () => {
    expect(
      EnvSchema.parse({ OUTBOUND_PROXY_URL: "socks5://127.0.0.1:1080" }).OUTBOUND_PROXY_URL
    ).toBe("socks5://127.0.0.1:1080");
  });

  test("rejects unsupported protocols and non-urls", () => {
    expect(() => EnvSchema.parse({ OUTBOUND_PROXY_URL: "ftp://proxy.example" })).toThrow(
      /OUTBOUND_PROXY_URL/
    );
    expect(() => EnvSchema.parse({ OUTBOUND_PROXY_URL: "not a url" })).toThrow(
      /OUTBOUND_PROXY_URL/
    );
  });
});
