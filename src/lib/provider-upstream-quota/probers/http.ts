import "server-only";

import { mergeResolvedCustomHeaders } from "@/lib/custom-headers";
import { createProxyAgentForProvider, fetchWithDispatcher } from "@/lib/proxy-agent";
import type { UpstreamQuotaProbeResult, UpstreamQuotaProbeTarget } from "../types";

export const UPSTREAM_QUOTA_PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 300;

export type UpstreamQuotaJsonResponse =
  | { ok: true; status: number; json: unknown }
  | Extract<UpstreamQuotaProbeResult, { ok: false }>;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function extractUpstreamMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
    for (const key of ["msg", "message", "error_msg"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return fallback;
}

async function doFetch(
  url: string,
  headers: Record<string, string>,
  dispatcher: unknown | undefined
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_QUOTA_PROBE_TIMEOUT_MS);
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers,
      signal: controller.signal,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    return await fetchWithDispatcher(url, init);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read-only GET to an upstream quota endpoint through the provider's proxy settings.
 * Provider custom headers are merged but never override the auth headers set by the prober.
 */
export async function fetchUpstreamQuotaJson(
  target: UpstreamQuotaProbeTarget,
  url: string,
  authHeaders: Record<string, string>
): Promise<UpstreamQuotaJsonResponse> {
  const headers: Record<string, string> = { Accept: "application/json" };
  mergeResolvedCustomHeaders(headers, target.customHeaders, { getHeader: () => null });
  Object.assign(headers, authHeaders);

  let response: Response;
  try {
    const proxyConfig = createProxyAgentForProvider(
      {
        id: target.id,
        name: target.name,
        proxyUrl: target.proxyUrl,
        proxyFallbackToDirect: target.proxyFallbackToDirect,
      },
      url
    );
    try {
      response = await doFetch(url, headers, proxyConfig?.agent);
    } catch (error) {
      if (!proxyConfig?.fallbackToDirect) throw error;
      response = await doFetch(url, headers, undefined);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? `timeout after ${UPSTREAM_QUOTA_PROBE_TIMEOUT_MS}ms`
          : error.message
        : String(error);
    return { ok: false, kind: "network", message: truncate(message, MAX_ERROR_MESSAGE_CHARS) };
  }

  let text = "";
  try {
    text = truncate(await response.text(), MAX_BODY_CHARS);
  } catch (error) {
    return {
      ok: false,
      kind: "network",
      statusCode: response.status,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const message = truncate(
      extractUpstreamMessage(json, text || `HTTP ${response.status}`),
      MAX_ERROR_MESSAGE_CHARS
    );
    const kind =
      response.status === 401 || response.status === 403
        ? "credential_invalid"
        : response.status === 402
          ? "insufficient_balance"
          : "http_error";
    return { ok: false, kind, statusCode: response.status, message };
  }

  if (json === undefined) {
    return {
      ok: false,
      kind: "parse",
      statusCode: response.status,
      message: "response is not valid JSON",
    };
  }

  return { ok: true, status: response.status, json };
}

/** Parse numbers that upstreams may send as strings. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse a reset time into epoch milliseconds.
 * Accepts epoch seconds, epoch milliseconds, numeric strings, and ISO-8601 strings.
 */
export function parseResetTime(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function clampUsedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
}

export function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}
