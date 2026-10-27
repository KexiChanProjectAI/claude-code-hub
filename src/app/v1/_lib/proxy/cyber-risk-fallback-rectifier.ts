/**
 * Cyber Risk Fallback - provider-level reactive retry for cybersecurity-risk refusals.
 *
 * Trigger: upstream rejects the request with a cyber-policy message such as
 *   "This content was flagged for possible cybersecurity risk ..." (real 4xx, fake-200, or stream gate frame).
 * Action: when the provider has a cyber_risk_fallback_rules entry whose source matches the execution
 *   model (or, failing that, the original client model), switch to the rule target model and retry the
 *   same provider once.
 *
 * This module only holds the pure detection / rule resolution logic; side effects (session mutation,
 * audit persistence, retry decision) live in the forwarder's reactive rectifier pipeline.
 */

import { matchCyberRiskKeyword } from "@/lib/cyber-risk-detection";
import {
  findMatchingProviderModelRedirectRule,
  resolveProviderModelRedirectTarget,
} from "@/lib/provider-model-redirects";
import type { ProviderModelRedirectRule } from "@/types/provider";
import { ProxyError } from "./errors";

export type CyberRiskFallbackResolution = {
  /** model the rule was matched against (execution model, or original model as fallback) */
  matchedModel: string;
  /** model that was rejected upstream */
  fromModel: string;
  /** model to retry with */
  toModel: string;
  rule: ProviderModelRedirectRule;
};

/** Collect every text surface of an upstream error that may carry the refusal message. */
export function collectCyberRiskErrorTexts(error: unknown, errorMessage?: string | null): string[] {
  const texts: string[] = [];
  if (errorMessage) texts.push(errorMessage);
  if (error instanceof Error && error.message) texts.push(error.message);
  if (error instanceof ProxyError) {
    const upstream = error.upstreamError;
    if (upstream?.body) texts.push(upstream.body);
    if (upstream?.rawBody) texts.push(upstream.rawBody);
  }
  return texts;
}

/** Returns the matched cyber-risk keyword from the error, or null when the error is unrelated. */
export function detectCyberRiskFallbackTrigger(
  error: unknown,
  errorMessage?: string | null
): string | null {
  for (const text of collectCyberRiskErrorTexts(error, errorMessage)) {
    const keyword = matchCyberRiskKeyword(text);
    if (keyword) return keyword;
  }
  return null;
}

/**
 * Resolve the fallback model for a rejected request.
 *
 * Rules are evaluated in order against the execution model first; if none match, against the
 * original client model. Returns null when no rule matches or when the target equals the rejected
 * model (no-op retry guard).
 */
export function resolveCyberRiskFallback(
  rules: ProviderModelRedirectRule[] | null | undefined,
  executionModel: string | null | undefined,
  originalModel?: string | null
): CyberRiskFallbackResolution | null {
  if (!rules || rules.length === 0 || !executionModel) return null;

  const candidates = [executionModel];
  if (originalModel && originalModel !== executionModel) candidates.push(originalModel);

  for (const candidate of candidates) {
    const rule = findMatchingProviderModelRedirectRule(candidate, rules);
    if (!rule) continue;
    const toModel = resolveProviderModelRedirectTarget(candidate, rule).trim();
    if (!toModel || toModel === executionModel) return null;
    return { matchedModel: candidate, fromModel: executionModel, toModel, rule };
  }

  return null;
}
