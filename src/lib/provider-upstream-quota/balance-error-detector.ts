const BALANCE_EXHAUSTED_PATTERNS = [
  "余额不足",
  "insufficient balance",
  "insufficient_balance",
  "insufficient_credit",
  "insufficient credit",
  "balance is not enough",
  "no enough balance",
  "not enough balance",
] as const;

function stringifyParsed(parsed: unknown): string {
  if (parsed === undefined || parsed === null) return "";
  if (typeof parsed === "string") return parsed;
  try {
    return JSON.stringify(parsed);
  } catch {
    return "";
  }
}

export type UpstreamQuotaExhaustionKind = "reactive_402" | "reactive_429_balance";

/**
 * Detect an upstream "out of balance / quota" response.
 *
 * - 402 Payment Required always counts.
 * - 429 counts only when the body names an insufficient balance (plain rate limits do not).
 */
export function detectUpstreamQuotaExhausted(
  statusCode: number,
  body?: string | null,
  parsed?: unknown
): UpstreamQuotaExhaustionKind | null {
  if (statusCode === 402) return "reactive_402";
  if (statusCode !== 429) return null;

  const haystack = `${body ?? ""}\n${stringifyParsed(parsed)}`.toLowerCase();
  if (!haystack.trim()) return null;
  return BALANCE_EXHAUSTED_PATTERNS.some((pattern) => haystack.includes(pattern))
    ? "reactive_429_balance"
    : null;
}
