import { describe, expect, it } from "vitest";
import { validateProviderProtocolsInput } from "@/lib/provider-protocols/validate";

describe("validateProviderProtocolsInput", () => {
  it("accepts a valid multi-protocol payload", () => {
    expect(
      validateProviderProtocolsInput({
        providerType: "claude-auth",
        protocols: ["claude", "openai", "response"],
        protocolUrls: { response: "https://r.example.com/v1" },
      })
    ).toEqual([]);
  });

  it("accepts empty input and partial updates without a type", () => {
    expect(validateProviderProtocolsInput({})).toEqual([]);
    expect(
      validateProviderProtocolsInput({
        protocols: ["openai"],
        protocolUrls: { openai: "http://x" },
      })
    ).toEqual([]);
  });

  it("rejects unknown protocols", () => {
    expect(
      validateProviderProtocolsInput({ providerType: "claude", protocols: ["claude", "smtp"] })
    ).toEqual([{ path: "protocols", message: "Unknown protocols: smtp" }]);
  });

  it("rejects mixing gemini into a multi-protocol row", () => {
    const issues = validateProviderProtocolsInput({
      providerType: "codex",
      protocols: ["response", "gemini"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("protocols");
  });

  it("rejects extra protocols on gemini rows", () => {
    expect(
      validateProviderProtocolsInput({ providerType: "gemini", protocols: ["gemini", "claude"] })
    ).toEqual([{ path: "protocols", message: "gemini providers serve only their own protocol" }]);
    expect(
      validateProviderProtocolsInput({ providerType: "gemini-cli", protocols: ["gemini-cli"] })
    ).toEqual([]);
  });

  it("validates URL override keys and values", () => {
    const issues = validateProviderProtocolsInput({
      providerType: "claude",
      protocols: ["claude", "openai"],
      protocolUrls: {
        claude: "https://primary",
        response: "https://not-served",
        openai: "ftp://bad",
        bogus: "https://x",
      },
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "The primary protocol claude uses the provider url; remove its override",
      "URL override for response, which is not in protocols",
      "URL override for openai must be an http(s) URL",
      "Unknown protocol: bogus",
    ]);
    expect(issues.every((issue) => issue.path === "protocol_urls")).toBe(true);
  });

  it("rejects non-string and unparseable override values", () => {
    expect(
      validateProviderProtocolsInput({ protocolUrls: { openai: 3, response: "not a url" } })
    ).toHaveLength(2);
  });
});
