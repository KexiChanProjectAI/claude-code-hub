import { describe, expect, it } from "vitest";
import type { ClientFormat } from "@/app/v1/_lib/proxy/format-mapper";
import { checkFormatProviderTypeCompatibility } from "@/app/v1/_lib/proxy/provider-selector";
import {
  ALL_CATALOG_PROVIDER_TYPES,
  CATALOG_PROTOCOLS,
  protocolForProviderType,
} from "@/lib/model-catalog/protocols";
import type { Provider } from "@/types/provider";

const PROVIDER_TYPES: Provider["providerType"][] = [
  "claude",
  "claude-auth",
  "codex",
  "gemini",
  "gemini-cli",
  "openai-compatible",
];
const FORMATS: ClientFormat[] = ["claude", "response", "openai", "gemini", "gemini-cli"];

describe("CATALOG_PROTOCOLS", () => {
  it("covers every client format exactly once", () => {
    expect(CATALOG_PROTOCOLS.map((protocol) => protocol.id).sort()).toEqual([...FORMATS].sort());
  });

  it("matches the proxy's strict format/provider-type compatibility matrix", () => {
    for (const protocol of CATALOG_PROTOCOLS) {
      for (const providerType of PROVIDER_TYPES) {
        expect(
          protocol.providerTypes.includes(providerType),
          `${protocol.id} x ${providerType}`
        ).toBe(checkFormatProviderTypeCompatibility(protocol.id, providerType));
      }
    }
  });

  it("maps every provider type to exactly one protocol", () => {
    expect([...ALL_CATALOG_PROVIDER_TYPES].sort()).toEqual([...PROVIDER_TYPES].sort());
    expect(protocolForProviderType("claude-auth")).toBe("claude");
    expect(protocolForProviderType("codex")).toBe("response");
    expect(protocolForProviderType("openai-compatible")).toBe("openai");
    expect(protocolForProviderType("gemini-cli")).toBe("gemini-cli");
    expect(protocolForProviderType("unknown" as Provider["providerType"])).toBeNull();
  });
});
