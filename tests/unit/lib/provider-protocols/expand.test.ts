import { describe, expect, it } from "vitest";
import { protocolForProviderType } from "@/lib/model-catalog/protocols";
import {
  ALL_PROVIDER_PROTOCOLS,
  effectiveProviderTypeForProtocol,
  expandProviderBindings,
  expandProviderInstances,
  expandProviders,
  expandProvidersCached,
  findInstanceForFormat,
  getEffectiveProviderTypes,
  getProviderProtocols,
  instanceProtocol,
  isMultiProtocolCapableType,
  MULTI_PROTOCOL_IDS,
  narrowInstancesForFormat,
  normalizeProviderProtocolUrls,
  normalizeProviderProtocols,
  protocolOfProviderType,
  providerServesProtocol,
  resolveProtocolUrl,
} from "@/lib/provider-protocols/expand";
import type { Provider, ProviderType } from "@/types/provider";

const PROVIDER_TYPES: ProviderType[] = [
  "claude",
  "claude-auth",
  "codex",
  "gemini",
  "gemini-cli",
  "openai-compatible",
];

function row(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `p${id}`,
    url: "https://up.example.com/v1",
    providerType: "claude",
    isEnabled: true,
    providerVendorId: 7,
    weight: 1,
    priority: 0,
    ...overrides,
  } as Provider;
}

describe("protocolOfProviderType", () => {
  it("matches the catalog protocol map for every provider type", () => {
    for (const type of PROVIDER_TYPES) {
      expect(protocolOfProviderType(type)).toBe(protocolForProviderType(type));
    }
  });

  it("falls back to claude for unknown values", () => {
    expect(protocolOfProviderType("weird" as ProviderType)).toBe("claude");
  });

  it("flags only claude/openai/response types as multi-protocol capable", () => {
    expect(PROVIDER_TYPES.filter(isMultiProtocolCapableType).sort()).toEqual(
      ["claude", "claude-auth", "codex", "openai-compatible"].sort()
    );
  });
});

describe("effectiveProviderTypeForProtocol", () => {
  it("round-trips through the catalog protocol map for every primary and protocol", () => {
    for (const primary of PROVIDER_TYPES) {
      for (const protocol of ALL_PROVIDER_PROTOCOLS) {
        const effective = effectiveProviderTypeForProtocol(primary, protocol);
        expect(protocolForProviderType(effective), `${primary} x ${protocol}`).toBe(protocol);
      }
    }
  });

  it("keeps the Bearer-only Anthropic style of a claude-auth primary", () => {
    expect(effectiveProviderTypeForProtocol("claude-auth", "claude")).toBe("claude-auth");
    expect(effectiveProviderTypeForProtocol("codex", "claude")).toBe("claude");
    expect(effectiveProviderTypeForProtocol("claude", "claude")).toBe("claude");
  });

  it("maps openai and response to their provider types", () => {
    expect(effectiveProviderTypeForProtocol("claude", "openai")).toBe("openai-compatible");
    expect(effectiveProviderTypeForProtocol("claude", "response")).toBe("codex");
  });

  it("returns the primary for an unknown protocol", () => {
    expect(effectiveProviderTypeForProtocol("codex", "x" as never)).toBe("codex");
  });
});

describe("normalizeProviderProtocols", () => {
  it("defaults to the primary protocol for legacy rows", () => {
    expect(normalizeProviderProtocols("codex", undefined)).toEqual(["response"]);
    expect(normalizeProviderProtocols("claude-auth", [])).toEqual(["claude"]);
    expect(normalizeProviderProtocols("openai-compatible", "nope")).toEqual(["openai"]);
  });

  it("puts the primary first, dedupes and drops unknown or gemini entries", () => {
    expect(
      normalizeProviderProtocols("codex", ["claude", "openai", "claude", "gemini", "bogus", 3])
    ).toEqual(["response", "claude", "openai"]);
  });

  it("locks gemini rows to their own protocol", () => {
    expect(normalizeProviderProtocols("gemini", ["claude", "openai"])).toEqual(["gemini"]);
    expect(normalizeProviderProtocols("gemini-cli", ["gemini"])).toEqual(["gemini-cli"]);
  });
});

describe("normalizeProviderProtocolUrls", () => {
  it("keeps trimmed overrides for served non-primary protocols only", () => {
    expect(
      normalizeProviderProtocolUrls("claude", ["claude", "response"], {
        claude: "https://ignored",
        response: "  https://r.example.com  ",
        openai: "https://not-served",
        gemini: "https://bad",
        bogus: "https://bad",
      })
    ).toEqual({ response: "https://r.example.com" });
  });

  it("returns null for empty, blank or invalid input", () => {
    expect(normalizeProviderProtocolUrls("claude", ["claude", "openai"], null)).toBeNull();
    expect(normalizeProviderProtocolUrls("claude", ["claude", "openai"], [])).toBeNull();
    expect(normalizeProviderProtocolUrls("claude", ["claude", "openai"], "x")).toBeNull();
    expect(
      normalizeProviderProtocolUrls("claude", ["claude", "openai"], { openai: "   ", x: 1 })
    ).toBeNull();
    expect(
      normalizeProviderProtocolUrls("claude", ["claude", "openai"], { openai: 42 })
    ).toBeNull();
  });
});

describe("row helpers", () => {
  const multi = row(1, {
    providerType: "claude-auth",
    protocols: ["claude", "openai", "response"],
    protocolUrls: { response: "https://r.example.com" },
  });

  it("reports served protocols and effective types", () => {
    expect(getProviderProtocols(multi)).toEqual(["claude", "openai", "response"]);
    expect(getEffectiveProviderTypes(multi)).toEqual(["claude-auth", "openai-compatible", "codex"]);
    expect(providerServesProtocol(multi, "openai")).toBe(true);
    expect(providerServesProtocol(row(2), "openai")).toBe(false);
  });

  it("resolves per-protocol URLs with fallback to url", () => {
    expect(resolveProtocolUrl(multi, "response")).toBe("https://r.example.com");
    expect(resolveProtocolUrl(multi, "openai")).toBe("https://up.example.com/v1");
    expect(resolveProtocolUrl({ ...multi, protocolUrls: { openai: "  " } }, "openai")).toBe(
      "https://up.example.com/v1"
    );
  });

  it("uses primaryProviderType of an expanded instance", () => {
    const [, openaiInstance] = expandProviderInstances(multi);
    expect(getProviderProtocols(openaiInstance)).toEqual(["claude", "openai", "response"]);
  });
});

describe("expandProviderInstances", () => {
  it("expands a multi-protocol row into one instance per protocol sharing the id", () => {
    const instances = expandProviderInstances(
      row(1, {
        providerType: "claude",
        protocols: ["openai", "response"],
        protocolUrls: { response: "https://r.example.com", claude: "https://ignored" },
      })
    );
    expect(instances.map((i) => [i.id, i.protocol, i.providerType, i.url])).toEqual([
      [1, "claude", "claude", "https://up.example.com/v1"],
      [1, "openai", "openai-compatible", "https://up.example.com/v1"],
      [1, "response", "codex", "https://r.example.com"],
    ]);
    for (const instance of instances) {
      expect(instance.primaryProviderType).toBe("claude");
      expect(instance.protocols).toEqual(["claude", "openai", "response"]);
      expect(instance.protocolUrls).toEqual({ response: "https://r.example.com" });
    }
  });

  it("returns an annotated copy for single-protocol rows", () => {
    const source = row(2, { providerType: "gemini", protocols: ["claude"] });
    const [instance] = expandProviderInstances(source);
    expect(instance).not.toBe(source);
    expect(instance.protocol).toBe("gemini");
    expect(instance.providerType).toBe("gemini");
  });

  it("does not re-expand an instance", () => {
    const [instance] = expandProviderInstances(row(3));
    expect(expandProviderInstances(instance)).toEqual([instance]);
  });

  it("expands lists and memoizes by array reference", () => {
    const rows = [row(1, { protocols: ["claude", "openai"] }), row(2, { providerType: "codex" })];
    const expanded = expandProviders(rows);
    expect(expanded.map((p) => `${p.id}:${p.providerType}`)).toEqual([
      "1:claude",
      "1:openai-compatible",
      "2:codex",
    ]);
    const cached = expandProvidersCached(rows);
    expect(cached).toEqual(expanded);
    expect(expandProvidersCached(rows)).toBe(cached);
    expect(expandProvidersCached([...rows])).not.toBe(cached);
  });
});

describe("expandProviderBindings", () => {
  it("yields one (vendor, effective type, url) binding per served protocol", () => {
    expect(
      expandProviderBindings([
        {
          id: 1,
          providerVendorId: 9,
          providerType: "codex",
          url: "https://a",
          isEnabled: false,
          protocols: ["response", "claude"],
          protocolUrls: { claude: "https://a/anthropic" },
        },
        {
          id: 2,
          providerVendorId: null,
          providerType: "gemini",
          url: "https://g",
          isEnabled: true,
        },
      ])
    ).toEqual([
      {
        providerId: 1,
        vendorId: 9,
        providerType: "codex",
        url: "https://a",
        isEnabled: false,
        protocol: "response",
      },
      {
        providerId: 1,
        vendorId: 9,
        providerType: "claude",
        url: "https://a/anthropic",
        isEnabled: false,
        protocol: "claude",
      },
      {
        providerId: 2,
        vendorId: null,
        providerType: "gemini",
        url: "https://g",
        isEnabled: true,
        protocol: "gemini",
      },
    ]);
  });
});

describe("narrowInstancesForFormat / findInstanceForFormat", () => {
  const instances = expandProviders([
    row(1, { providerType: "claude", protocols: ["claude", "openai", "response"] }),
    row(2, { providerType: "codex" }),
    row(3, { providerType: "openai-compatible", protocols: ["openai", "claude"] }),
  ]);

  it("keeps exactly one instance per id, preferring the requested protocol", () => {
    const narrowed = narrowInstancesForFormat(instances, "openai");
    expect(narrowed.map((p) => `${p.id}:${p.providerType}`)).toEqual([
      "1:openai-compatible",
      "2:codex",
      "3:openai-compatible",
    ]);
  });

  it("falls back to the primary instance when the row does not serve the format", () => {
    const narrowed = narrowInstancesForFormat(instances, "gemini");
    expect(narrowed.map((p) => `${p.id}:${p.providerType}`)).toEqual([
      "1:claude",
      "2:codex",
      "3:openai-compatible",
    ]);
    expect(narrowInstancesForFormat(instances, null).map((p) => p.providerType)).toEqual([
      "claude",
      "codex",
      "openai-compatible",
    ]);
  });

  it("finds the instance for a format by id", () => {
    expect(findInstanceForFormat(instances, 1, "response")?.providerType).toBe("codex");
    expect(findInstanceForFormat(instances, 3, "claude")?.providerType).toBe("claude");
    expect(findInstanceForFormat(instances, 2, "claude")?.providerType).toBe("codex");
    expect(findInstanceForFormat(instances, 1, undefined)?.providerType).toBe("claude");
    expect(findInstanceForFormat(instances, 99, "claude")).toBeNull();
  });

  it("tolerates instances without protocol (older snapshots)", () => {
    const legacy = [row(5, { providerType: "codex" }), row(6, { providerType: "claude-auth" })];
    expect(instanceProtocol(legacy[0])).toBe("response");
    expect(findInstanceForFormat(legacy, 6, "claude")?.id).toBe(6);
    expect(narrowInstancesForFormat(legacy, "response")).toEqual(legacy);
  });

  it("exports the protocol constants", () => {
    expect(MULTI_PROTOCOL_IDS).toEqual(["claude", "openai", "response"]);
    expect(ALL_PROVIDER_PROTOCOLS).toHaveLength(5);
  });
});
