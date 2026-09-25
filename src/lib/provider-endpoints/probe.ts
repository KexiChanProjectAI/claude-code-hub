import "server-only";

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { SocksClient } from "socks";
import { getEnvConfig } from "@/lib/config/env.schema";
import {
  getEndpointCircuitStateSync,
  recordEndpointFailure,
  resetEndpointCircuit,
} from "@/lib/endpoint-circuit-breaker";
import { logger } from "@/lib/logger";
import { resolveOutboundProxyUrl } from "@/lib/outbound-proxy";
import { findProviderEndpointById, recordProviderEndpointProbeResult } from "@/repository";
import type { ProviderEndpoint, ProviderEndpointProbeSource } from "@/types/provider";

export type EndpointProbeMethod = "HEAD" | "GET" | "TCP";

export interface EndpointProbeResult {
  ok: boolean;
  method: EndpointProbeMethod;
  statusCode: number | null;
  latencyMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

function parseIntWithDefault(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_TIMEOUT_MS = Math.max(
  1,
  parseIntWithDefault(process.env.ENDPOINT_PROBE_TIMEOUT_MS, 5_000)
);

function resolveProbeMethod(): EndpointProbeMethod {
  const raw = process.env.ENDPOINT_PROBE_METHOD?.toUpperCase();
  if (raw === "HEAD" || raw === "GET") return raw;
  return "TCP";
}

function safeUrlForLog(rawUrl: string): string {
  try {
    // Avoid leaking credentials/querystring in logs.
    return new URL(rawUrl).origin;
  } catch {
    return "<invalid-url>";
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      redirect: "manual",
    });
    return { response, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

function toErrorInfo(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return { type: "timeout", message: error.message || "timeout" };
    }
    if (error instanceof TypeError) {
      // Fetch URL parsing failures should not leak the original URL.
      return { type: "invalid_url", message: "invalid_url" };
    }
    return { type: "network_error", message: error.message };
  }
  return { type: "unknown_error", message: String(error) };
}

function tcpProbeFailure(
  errorType: "timeout" | "network_error" | "proxy_connect_failed",
  errorMessage: string,
  latencyMs: number | null
): EndpointProbeResult {
  return {
    ok: false,
    method: "TCP",
    statusCode: null,
    latencyMs,
    errorType,
    errorMessage,
  };
}

function probeTcpViaHttpConnect(
  rawUrl: string,
  host: string,
  port: number,
  proxy: URL,
  timeoutMs: number
): Promise<EndpointProbeResult> {
  const start = Date.now();
  const secureProxy = proxy.protocol === "https:";
  const mod = secureProxy ? https : http;
  const proxyPort = proxy.port ? Number(proxy.port) : secureProxy ? 443 : 80;
  const connectHost = host.includes(":") ? `[${host}]` : host;
  const headers: Record<string, string> = {};
  if (proxy.username) {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }

  const { promise, resolve } = Promise.withResolvers<EndpointProbeResult>();
  let settled = false;
  const finish = (result: EndpointProbeResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const req = mod.request({
    hostname: proxy.hostname,
    port: proxyPort,
    method: "CONNECT",
    path: `${connectHost}:${port}`,
    headers,
    timeout: timeoutMs,
  });

  req.once("connect", (response, socket) => {
    const status = response.statusCode ?? 0;
    socket.destroy();
    if (status === 200) {
      finish({
        ok: true,
        method: "TCP",
        statusCode: null,
        latencyMs: Date.now() - start,
        errorType: null,
        errorMessage: null,
      });
      return;
    }
    finish(tcpProbeFailure("proxy_connect_failed", `CONNECT ${status}`, Date.now() - start));
  });

  req.once("timeout", () => {
    req.destroy();
    finish(tcpProbeFailure("timeout", "timeout", null));
  });

  req.once("error", (error) => {
    logger.debug("[EndpointProbe] TCP proxy CONNECT failed", {
      url: safeUrlForLog(rawUrl),
      errorMessage: error.message,
    });
    finish(tcpProbeFailure("network_error", error.message, Date.now() - start));
  });

  req.end();
  return promise;
}

async function probeTcpViaSocks(
  rawUrl: string,
  host: string,
  port: number,
  proxy: URL,
  timeoutMs: number
): Promise<EndpointProbeResult> {
  const start = Date.now();
  try {
    const { socket } = await SocksClient.createConnection({
      command: "connect",
      timeout: timeoutMs,
      proxy: {
        host: proxy.hostname,
        port: Number(proxy.port) || 1080,
        type: proxy.protocol === "socks5:" ? 5 : 4,
        userId: proxy.username ? decodeURIComponent(proxy.username) : undefined,
        password: proxy.password ? decodeURIComponent(proxy.password) : undefined,
      },
      destination: { host, port },
    });
    socket.destroy();
    return {
      ok: true,
      method: "TCP",
      statusCode: null,
      latencyMs: Date.now() - start,
      errorType: null,
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug("[EndpointProbe] TCP SOCKS probe failed", {
      url: safeUrlForLog(rawUrl),
      errorMessage: message,
    });
    if (/timed?\s*out|timeout/i.test(message)) {
      return tcpProbeFailure("timeout", "timeout", null);
    }
    return tcpProbeFailure("network_error", message, Date.now() - start);
  }
}

async function probeTcpThroughOutboundProxy(
  rawUrl: string,
  host: string,
  port: number,
  proxyUrl: string,
  timeoutMs: number
): Promise<EndpointProbeResult> {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return tcpProbeFailure("network_error", message, null);
  }

  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    return probeTcpViaHttpConnect(rawUrl, host, port, proxy, timeoutMs);
  }
  if (proxy.protocol === "socks4:" || proxy.protocol === "socks5:") {
    return probeTcpViaSocks(rawUrl, host, port, proxy, timeoutMs);
  }
  return tcpProbeFailure(
    "network_error",
    `Unsupported proxy protocol: ${proxy.protocol}. Supported protocols: http://, https://, socks5://, socks4://`,
    null
  );
}

async function probeEndpointTcp(rawUrl: string, timeoutMs: number): Promise<EndpointProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      method: "TCP",
      statusCode: null,
      latencyMs: null,
      errorType: "invalid_url",
      errorMessage: "invalid_url",
    };
  }

  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  const host = parsed.hostname;

  const outboundProxy = resolveOutboundProxyUrl({ explicit: null, targetUrl: rawUrl });
  if (outboundProxy.proxyUrl) {
    return probeTcpThroughOutboundProxy(rawUrl, host, port, outboundProxy.proxyUrl, timeoutMs);
  }

  const start = Date.now();
  return new Promise<EndpointProbeResult>((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs }, () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({
        ok: true,
        method: "TCP",
        statusCode: null,
        latencyMs,
        errorType: null,
        errorMessage: null,
      });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        ok: false,
        method: "TCP",
        statusCode: null,
        latencyMs: null,
        errorType: "timeout",
        errorMessage: "timeout",
      });
    });

    socket.on("error", (error) => {
      const latencyMs = Date.now() - start;
      logger.debug("[EndpointProbe] TCP probe failed", {
        url: safeUrlForLog(rawUrl),
        errorMessage: error.message,
      });
      socket.destroy();
      resolve({
        ok: false,
        method: "TCP",
        statusCode: null,
        latencyMs,
        errorType: "network_error",
        errorMessage: error.message,
      });
    });
  });
}

async function tryProbe(
  url: string,
  method: EndpointProbeMethod,
  timeoutMs: number
): Promise<EndpointProbeResult> {
  try {
    const { response, latencyMs } = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          "cache-control": "no-store",
        },
      },
      timeoutMs
    );

    const statusCode = response.status;
    const ok = statusCode < 500;

    return {
      ok,
      method,
      statusCode,
      latencyMs,
      errorType: ok ? null : "http_5xx",
      errorMessage: ok ? null : `HTTP ${statusCode}`,
    };
  } catch (error) {
    const { type, message } = toErrorInfo(error);
    logger.debug("[EndpointProbe] Probe request failed", {
      url: safeUrlForLog(url),
      method,
      type,
      errorMessage: message,
    });
    return {
      ok: false,
      method,
      statusCode: null,
      latencyMs: null,
      errorType: type,
      errorMessage: message,
    };
  }
}

export async function probeEndpointUrl(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<EndpointProbeResult> {
  const method = resolveProbeMethod();

  if (method === "TCP") {
    return probeEndpointTcp(url, timeoutMs);
  }

  // HTTP-based probing: try HEAD first, fallback to GET on network failure
  const head = await tryProbe(url, "HEAD", timeoutMs);
  if (head.statusCode === null) {
    return tryProbe(url, "GET", timeoutMs);
  }
  return head;
}

type ProbeTarget = Pick<ProviderEndpoint, "id" | "url" | "lastProbedAt" | "lastProbeOk">;

export async function probeProviderEndpointAndRecordByEndpoint(input: {
  endpoint: ProbeTarget;
  source: ProviderEndpointProbeSource;
  timeoutMs?: number;
}): Promise<EndpointProbeResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await probeEndpointUrl(input.endpoint.url, timeoutMs);
  const probedAt = new Date();

  if (!result.ok) {
    // Keep circuit-breaker logs free of raw upstream error strings.
    const message = result.statusCode
      ? `HTTP ${result.statusCode}`
      : result.errorType || "probe_failed";
    await recordEndpointFailure(input.endpoint.id, new Error(message));
  } else {
    // Probe success: best-effort reset circuit breaker state (cross-instance safe).
    // Note: do not rely on in-memory state only; Redis may contain open/half-open state from another instance.
    if (getEnvConfig().ENABLE_ENDPOINT_CIRCUIT_BREAKER) {
      const previousState = getEndpointCircuitStateSync(input.endpoint.id);
      try {
        await resetEndpointCircuit(input.endpoint.id);
        if (previousState !== "closed") {
          logger.info("[EndpointProbe] Probe success, circuit reset", {
            endpointId: input.endpoint.id,
            previousState,
          });
        }
      } catch (error) {
        logger.warn("[EndpointProbe] Probe success but failed to reset circuit", {
          endpointId: input.endpoint.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Always record probe results to history table (removed filtering logic)
  await recordProviderEndpointProbeResult({
    endpointId: input.endpoint.id,
    source: input.source,
    ok: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    errorType: result.errorType,
    errorMessage: result.errorMessage,
    probedAt,
  });

  return result;
}

export async function probeProviderEndpointAndRecord(input: {
  endpointId: number;
  source: ProviderEndpointProbeSource;
  timeoutMs?: number;
}): Promise<EndpointProbeResult | null> {
  const endpoint = await findProviderEndpointById(input.endpointId);
  if (!endpoint) {
    return null;
  }

  return probeProviderEndpointAndRecordByEndpoint({
    endpoint,
    source: input.source,
    timeoutMs: input.timeoutMs,
  });
}
