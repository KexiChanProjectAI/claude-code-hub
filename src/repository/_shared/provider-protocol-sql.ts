import { type SQL, sql } from "drizzle-orm";
import { providers } from "@/drizzle/schema";
import type { ProviderType } from "@/types/provider";

/**
 * SQL predicates for multi-protocol provider rows.
 *
 * A row binds (effective type, url) pairs: its primary binding (`provider_type`, `url`) plus one
 * binding per extra protocol in `protocols`, with the effective type derived from the protocol
 * and the URL taken from `protocol_urls` when overridden. This mirrors
 * `expandProviderBindingsForRow` in `src/lib/provider-protocols/expand.ts`.
 */
interface ProviderColumnRefs {
  providerType: SQL | typeof providers.providerType;
  url: SQL | typeof providers.url;
  protocols: SQL | typeof providers.protocols;
  protocolUrls: SQL | typeof providers.protocolUrls;
}

const TABLE_REFS: ProviderColumnRefs = {
  providerType: providers.providerType,
  url: providers.url,
  protocols: providers.protocols,
  protocolUrls: providers.protocolUrls,
};

/** Column refs for raw SQL that aliases the providers table (e.g. `FROM providers p`). */
export function aliasedProviderColumns(alias: string): ProviderColumnRefs {
  return {
    providerType: sql.raw(`${alias}.provider_type`),
    url: sql.raw(`${alias}.url`),
    protocols: sql.raw(`${alias}.protocols`),
    protocolUrls: sql.raw(`${alias}.protocol_urls`),
  };
}

/** Effective provider type of protocol `proto` (a text SQL expression) on a row. */
export function effectiveProviderTypeSql(cols: ProviderColumnRefs, proto: SQL): SQL {
  return sql`(CASE ${proto}
    WHEN 'claude' THEN (CASE WHEN ${cols.providerType} = 'claude-auth' THEN 'claude-auth' ELSE 'claude' END)
    WHEN 'openai' THEN 'openai-compatible'
    WHEN 'response' THEN 'codex'
    ELSE ${cols.providerType} END)`;
}

function extraProtocolExists(cols: ProviderColumnRefs, predicate: (proto: SQL) => SQL): SQL {
  const proto = sql.raw("cch_proto.value");
  return sql`(${cols.providerType} NOT IN ('gemini', 'gemini-cli') AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${cols.protocols}) AS cch_proto(value)
    WHERE ${predicate(proto)}
  ))`;
}

/** Row serves the effective provider type through any of its protocols. */
export function providerServesTypeSql(
  providerType: ProviderType | SQL,
  cols: ProviderColumnRefs = TABLE_REFS
): SQL {
  return sql`(${cols.providerType} = ${providerType} OR ${extraProtocolExists(
    cols,
    (proto) => sql`${effectiveProviderTypeSql(cols, proto)} = ${providerType}`
  )})`;
}

/** Row binds exactly (effective provider type, url). */
export function providerBindsTypeUrlSql(
  providerType: ProviderType | SQL,
  url: string | SQL,
  cols: ProviderColumnRefs = TABLE_REFS
): SQL {
  return sql`((${cols.providerType} = ${providerType} AND ${cols.url} = ${url}) OR ${extraProtocolExists(
    cols,
    (proto) =>
      sql`${effectiveProviderTypeSql(cols, proto)} = ${providerType} AND COALESCE(NULLIF(${cols.protocolUrls} ->> ${proto}, ''), ${cols.url}) = ${url}`
  )})`;
}
