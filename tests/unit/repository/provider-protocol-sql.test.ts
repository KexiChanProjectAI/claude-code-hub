import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  aliasedProviderColumns,
  effectiveProviderTypeSql,
  providerBindsTypeUrlSql,
  providerServesTypeSql,
} from "@/repository/_shared/provider-protocol-sql";

const dialect = new PgDialect();

function render(fragment: ReturnType<typeof sql>) {
  return dialect.sqlToQuery(fragment);
}

describe("provider protocol SQL predicates", () => {
  it("matches the primary binding or an extra protocol binding with URL override", () => {
    const query = render(providerBindsTypeUrlSql("codex", "https://a"));
    expect(query.sql).toContain('"providers"."provider_type" = $1');
    expect(query.sql).toContain('"providers"."url" = $2');
    expect(query.sql).toContain("jsonb_array_elements_text");
    expect(query.sql).toContain("NOT IN ('gemini', 'gemini-cli')");
    expect(query.sql).toContain("COALESCE(NULLIF(");
    expect(query.params).toEqual(["codex", "https://a", "codex", "https://a"]);
  });

  it("checks served types without a URL", () => {
    const query = render(providerServesTypeSql("openai-compatible"));
    expect(query.sql).not.toContain("COALESCE");
    expect(query.params).toEqual(["openai-compatible", "openai-compatible"]);
  });

  it("renders aliased columns for raw SQL", () => {
    const cols = aliasedProviderColumns("p");
    const query = render(providerBindsTypeUrlSql(sql`e.provider_type`, sql`e.url`, cols));
    expect(query.sql).toContain("p.provider_type = e.provider_type");
    expect(query.sql).toContain("p.protocol_urls ->>");
    expect(query.params).toEqual([]);
  });

  it("derives the effective type from the protocol and the claude-auth primary", () => {
    const query = render(effectiveProviderTypeSql(aliasedProviderColumns("p"), sql.raw("x")));
    expect(query.sql).toContain("WHEN 'claude' THEN (CASE WHEN p.provider_type = 'claude-auth'");
    expect(query.sql).toContain("WHEN 'openai' THEN 'openai-compatible'");
    expect(query.sql).toContain("WHEN 'response' THEN 'codex'");
  });
});
