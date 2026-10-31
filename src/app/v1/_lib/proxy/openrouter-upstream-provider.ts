import { hasOpenRouterProviderRouting } from "@/lib/openrouter/provider-routing";
import type { OpenRouterProviderRouting } from "@/types/provider";
import type { SpecialSetting } from "@/types/special-settings";
import { extractJsonChunks } from "./actual-response-model";

export type OpenRouterUpstreamProviderInfo = {
  upstreamProvider: string;
  generationId: string | null;
};

const MAX_PROVIDER_NAME_LENGTH = 128;

type OpenRouterProviderLike = {
  readonly url?: string | null;
  readonly providerType?: string;
  readonly openrouterProviderRouting?: OpenRouterProviderRouting | null;
};

/**
 * Only OpenRouter puts a string `provider` field into its responses, so the extractor runs
 * when the provider URL points at OpenRouter or when OpenRouter routing is configured.
 */
export function isOpenRouterProvider(provider: OpenRouterProviderLike | null | undefined): boolean {
  if (!provider) return false;
  if (hasOpenRouterProviderRouting(provider)) return true;
  if (!provider.url) return false;
  try {
    const host = new URL(provider.url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProviderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PROVIDER_NAME_LENGTH);
}

function readGenerationId(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("gen-") ? value : null;
}

/**
 * Read `provider` (and the `gen-` id) from one response object. Besides the top level
 * (chat completions), the Anthropic `message_start.message` and Responses
 * `response.*` envelopes are checked.
 */
function readFromObject(obj: Record<string, unknown>): OpenRouterUpstreamProviderInfo | null {
  const candidates: Record<string, unknown>[] = [obj];
  if (isPlainObject(obj.message)) candidates.push(obj.message);
  if (isPlainObject(obj.response)) candidates.push(obj.response);

  for (const candidate of candidates) {
    const upstreamProvider = readProviderName(candidate.provider);
    if (upstreamProvider) {
      return { upstreamProvider, generationId: readGenerationId(candidate.id) };
    }
  }
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Extract the provider OpenRouter actually routed to. Accepts a JSON body or an SSE /
 * NDJSON stream; never throws and returns null when nothing is found.
 */
export function extractOpenRouterUpstreamProvider(
  bodyText: string | null | undefined
): OpenRouterUpstreamProviderInfo | null {
  if (!bodyText || typeof bodyText !== "string") return null;

  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{")) {
    const whole = parseObject(trimmed);
    if (whole) return readFromObject(whole);
  }

  for (const chunk of extractJsonChunks(bodyText)) {
    const obj = parseObject(chunk);
    if (!obj) continue;
    const hit = readFromObject(obj);
    if (hit) return hit;
  }
  return null;
}

type SessionLike = {
  readonly provider?: OpenRouterProviderLike | null;
  addSpecialSetting(setting: SpecialSetting): void;
  getSpecialSettings(): SpecialSetting[] | null;
};

/**
 * Record the OpenRouter upstream provider as a response special setting, then return the
 * session special settings for persistence. Safe to call for any provider.
 */
export function withOpenRouterUpstreamProvider(
  session: SessionLike,
  bodyText: string | null | undefined
): SpecialSetting[] | undefined {
  if (isOpenRouterProvider(session.provider)) {
    const info = extractOpenRouterUpstreamProvider(bodyText);
    if (info) {
      session.addSpecialSetting({
        type: "openrouter_upstream_provider",
        scope: "response",
        hit: true,
        upstreamProvider: info.upstreamProvider,
        generationId: info.generationId,
      });
    }
  }
  return session.getSpecialSettings() ?? undefined;
}
