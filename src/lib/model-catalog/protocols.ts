import type { Provider } from "@/types/provider";
import type { CatalogProtocolId } from "./types";

export interface CatalogProtocolDefinition {
  id: CatalogProtocolId;
  label: string;
  endpointPath: string;
  providerTypes: Provider["providerType"][];
}

/**
 * Inbound protocol -> provider types that can serve it.
 *
 * The proxy performs no cross-protocol conversion, so this must stay identical to
 * `checkFormatProviderTypeCompatibility` in `src/app/v1/_lib/proxy/provider-selector.ts`
 * (a unit test enforces the parity). Do not use the looser `getProviderTypesForFormat`
 * from the models list handler here.
 *
 * Labels are stable English strings shared by the JSON and Markdown outputs.
 */
export const CATALOG_PROTOCOLS: ReadonlyArray<CatalogProtocolDefinition> = [
  {
    id: "claude",
    label: "Anthropic Messages API",
    endpointPath: "/v1/messages",
    providerTypes: ["claude", "claude-auth"],
  },
  {
    id: "response",
    label: "OpenAI Responses API",
    endpointPath: "/v1/responses",
    providerTypes: ["codex"],
  },
  {
    id: "openai",
    label: "OpenAI Chat Completions API",
    endpointPath: "/v1/chat/completions",
    providerTypes: ["openai-compatible"],
  },
  {
    id: "gemini",
    label: "Gemini API",
    endpointPath: "/v1beta/models/{model}:generateContent",
    providerTypes: ["gemini"],
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI (Code Assist) API",
    endpointPath: "/v1internal/models/{model}:generateContent",
    providerTypes: ["gemini-cli"],
  },
];

export const ALL_CATALOG_PROVIDER_TYPES: Provider["providerType"][] = CATALOG_PROTOCOLS.flatMap(
  (protocol) => protocol.providerTypes
);

const PROTOCOL_BY_PROVIDER_TYPE = new Map<Provider["providerType"], CatalogProtocolId>(
  CATALOG_PROTOCOLS.flatMap((protocol) =>
    protocol.providerTypes.map((providerType) => [providerType, protocol.id] as const)
  )
);

export function protocolForProviderType(
  providerType: Provider["providerType"]
): CatalogProtocolId | null {
  return PROTOCOL_BY_PROVIDER_TYPE.get(providerType) ?? null;
}
