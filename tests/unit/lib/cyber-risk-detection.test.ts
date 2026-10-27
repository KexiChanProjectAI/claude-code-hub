import { describe, expect, test } from "vitest";
import { CYBER_RISK_KEYWORD_PATTERNS, matchCyberRiskKeyword } from "@/lib/cyber-risk-detection";

describe("matchCyberRiskKeyword", () => {
  test("matches the Anthropic cyber refusal message", () => {
    expect(
      matchCyberRiskKeyword(
        "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request."
      )
    ).toBe("flagged for possible cybersecurity risk");
  });

  test("matches the structured cyber_policy code", () => {
    expect(matchCyberRiskKeyword('{"error":{"code":"cyber_policy"}}')).toBe("cyber_policy");
  });

  test("matches the trusted access hint and generic wording", () => {
    expect(matchCyberRiskKeyword("apply for Trusted Access for Cyber")).toBe(
      "Trusted Access for Cyber"
    );
    expect(matchCyberRiskKeyword("blocked: CYBERSECURITY RISK")).toBe("CYBERSECURITY RISK");
  });

  test("returns null for unrelated or empty text", () => {
    expect(matchCyberRiskKeyword("rate limit exceeded")).toBeNull();
    expect(matchCyberRiskKeyword("cyber_policyx")).toBeNull();
    expect(matchCyberRiskKeyword("")).toBeNull();
    expect(matchCyberRiskKeyword(null)).toBeNull();
    expect(matchCyberRiskKeyword(undefined)).toBeNull();
  });

  test("exposes the keyword pattern list", () => {
    expect(CYBER_RISK_KEYWORD_PATTERNS).toHaveLength(4);
  });
});
