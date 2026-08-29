import { timingSafeEqual } from "node:crypto";

function booleanFromEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  return raw !== "false" && raw !== "0";
}

export function isMetricsEnabled(): boolean {
  return booleanFromEnv(process.env.METRICS_ENABLED, true);
}

export function getMetricsToken(): string | undefined {
  const token = process.env.METRICS_TOKEN?.trim();
  return token ? token : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorizeMetricsRequest(request: Request): boolean {
  const token = getMetricsToken();
  if (!token) return true;

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    if (safeEqual(authorization.slice("Bearer ".length), token)) return true;
  }

  const headerToken = request.headers.get("x-metrics-token");
  if (headerToken && safeEqual(headerToken, token)) return true;

  return false;
}
