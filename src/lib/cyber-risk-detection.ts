/**
 * Cybersecurity-risk refusal detection.
 *
 * Upstream classifiers (e.g. Anthropic cyber_policy) reject some requests with messages such as
 * "This content was flagged for possible cybersecurity risk". The text can arrive as a real HTTP 400
 * body, a fake-200 JSON / Responses `response.failed` payload, or a streamed error frame.
 */
export const CYBER_RISK_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bcyber_policy\b/iu,
  /flagged\s+for\s+possible\s+cybersecurity\s+risk/iu,
  /trusted\s+access\s+for\s+cyber/iu,
  /cybersecurity\s+risk/iu,
];

/** Returns the first matched cyber-risk keyword, or null when the text is unrelated. */
export function matchCyberRiskKeyword(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of CYBER_RISK_KEYWORD_PATTERNS) {
    const match = text.match(re);
    if (match?.[0]) return match[0];
  }
  return null;
}
