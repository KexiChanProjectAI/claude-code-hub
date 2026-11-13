import type {
  Provider,
  ProviderProtocol,
  ProviderProtocolUrls,
  ProviderType,
} from "@/types/provider";

/**
 * Multi-protocol providers.
 *
 * One `providers` row may serve several inbound protocols. The proxy runtime never sees a
 * multi-protocol row directly: the row is expanded into one in-memory instance per protocol,
 * all sharing the same `id` (so limits, sessions and the provider circuit stay shared), each
 * carrying the *effective* `providerType` that every type-gated code path (format compatibility,
 * auth headers, overrides, usage parsing, endpoint pool) already understands.
 *
 * Kept free of server-only imports so UI, actions, repository and tests can all use it.
 */

/** Protocols that can be combined on one row. Gemini rows always serve only their own protocol. */
export const MULTI_PROTOCOL_IDS: readonly ProviderProtocol[] = Object.freeze([
  "claude",
  "openai",
  "response",
]);

export const ALL_PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = Object.freeze([
  "claude",
  "openai",
  "response",
  "gemini",
  "gemini-cli",
]);

const MULTI_PROTOCOL_SET: ReadonlySet<ProviderProtocol> = new Set(MULTI_PROTOCOL_IDS);

/** The single protocol a provider type serves (mirrors CATALOG_PROTOCOLS). */
export function protocolOfProviderType(providerType: ProviderType): ProviderProtocol {
  switch (providerType) {
    case "claude":
    case "claude-auth":
      return "claude";
    case "codex":
      return "response";
    case "openai-compatible":
      return "openai";
    case "gemini":
      return "gemini";
    case "gemini-cli":
      return "gemini-cli";
    default:
      return "claude";
  }
}

export function isMultiProtocolCapableType(providerType: ProviderType): boolean {
  return MULTI_PROTOCOL_SET.has(protocolOfProviderType(providerType));
}

/**
 * Effective provider type an instance uses for a protocol.
 * The primary type decides the Anthropic auth style: `claude-auth` stays Bearer-only.
 */
export function effectiveProviderTypeForProtocol(
  primary: ProviderType,
  protocol: ProviderProtocol
): ProviderType {
  switch (protocol) {
    case "claude":
      return primary === "claude-auth" ? "claude-auth" : "claude";
    case "openai":
      return "openai-compatible";
    case "response":
      return "codex";
    case "gemini":
      return "gemini";
    case "gemini-cli":
      return "gemini-cli";
    default:
      return primary;
  }
}

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string" && (ALL_PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Normalize a stored/submitted protocol list:
 * - gemini rows -> only their own protocol
 * - otherwise keep known multi protocols, dedupe, primary protocol first
 * - missing or empty -> primary protocol only (legacy rows behave as before)
 */
export function normalizeProviderProtocols(
  primary: ProviderType,
  protocols: unknown
): ProviderProtocol[] {
  const primaryProtocol = protocolOfProviderType(primary);
  if (!MULTI_PROTOCOL_SET.has(primaryProtocol)) {
    return [primaryProtocol];
  }
  const result: ProviderProtocol[] = [primaryProtocol];
  if (Array.isArray(protocols)) {
    for (const value of protocols) {
      if (isProviderProtocol(value) && MULTI_PROTOCOL_SET.has(value) && !result.includes(value)) {
        result.push(value);
      }
    }
  }
  return result;
}

/**
 * Normalize per-protocol URL overrides against a normalized protocol list:
 * drops keys for unserved protocols, the primary protocol (it uses `url`) and blank values.
 * Returns null when nothing remains.
 */
export function normalizeProviderProtocolUrls(
  primary: ProviderType,
  protocols: readonly ProviderProtocol[],
  protocolUrls: unknown
): ProviderProtocolUrls | null {
  if (!protocolUrls || typeof protocolUrls !== "object" || Array.isArray(protocolUrls)) {
    return null;
  }
  const primaryProtocol = protocolOfProviderType(primary);
  const result: ProviderProtocolUrls = {};
  for (const [key, value] of Object.entries(protocolUrls as Record<string, unknown>)) {
    if (!isProviderProtocol(key) || key === primaryProtocol || !protocols.includes(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    result[key] = trimmed;
  }
  return Object.keys(result).length > 0 ? result : null;
}

type ProtocolRow = Pick<Provider, "providerType" | "url"> &
  Partial<Pick<Provider, "protocolUrls" | "primaryProviderType">> & {
    protocols?: readonly ProviderProtocol[] | null;
  };

function primaryTypeOf(
  row: Pick<Provider, "providerType"> & Partial<Pick<Provider, "primaryProviderType">>
): ProviderType {
  return row.primaryProviderType ?? row.providerType;
}

/** Protocols a row (or an expanded instance) serves, normalized. */
export function getProviderProtocols(row: ProtocolRow): ProviderProtocol[] {
  return normalizeProviderProtocols(primaryTypeOf(row), row.protocols);
}

export function providerServesProtocol(row: ProtocolRow, protocol: ProviderProtocol): boolean {
  return getProviderProtocols(row).includes(protocol);
}

/** Effective provider types a row serves, primary first. */
export function getEffectiveProviderTypes(row: ProtocolRow): ProviderType[] {
  const primary = primaryTypeOf(row);
  return getProviderProtocols(row).map((protocol) =>
    effectiveProviderTypeForProtocol(primary, protocol)
  );
}

/** Upstream base URL for a protocol: override if configured, else the row's url. */
export function resolveProtocolUrl(row: ProtocolRow, protocol: ProviderProtocol): string {
  const override = row.protocolUrls?.[protocol];
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  return row.url;
}

/** Protocol an instance serves; tolerates instances without `protocol` (older snapshots). */
export function instanceProtocol(
  instance: Pick<Provider, "providerType" | "protocol">
): ProviderProtocol {
  return instance.protocol ?? protocolOfProviderType(instance.providerType);
}

/**
 * Expand one row into one instance per served protocol. The first instance is the primary one.
 * Single-protocol rows still get one (new) object annotated with `protocol`.
 */
export function expandProviderInstances(row: Provider): Provider[] {
  if (row.protocol) {
    // Already an expanded instance.
    return [row];
  }
  const primary = row.providerType;
  const protocols = normalizeProviderProtocols(primary, row.protocols);
  const protocolUrls = normalizeProviderProtocolUrls(primary, protocols, row.protocolUrls);
  return protocols.map((protocol) => ({
    ...row,
    protocols,
    protocolUrls,
    protocol,
    primaryProviderType: primary,
    providerType: effectiveProviderTypeForProtocol(primary, protocol),
    url: resolveProtocolUrl({ ...row, protocolUrls }, protocol),
  }));
}

export function expandProviders(rows: readonly Provider[]): Provider[] {
  const result: Provider[] = [];
  for (const row of rows) {
    result.push(...expandProviderInstances(row));
  }
  return result;
}

const expansionCache = new WeakMap<readonly Provider[], Provider[]>();

/** Memoized `expandProviders` keyed on the array reference (provider cache returns a stable array). */
export function expandProvidersCached(rows: readonly Provider[]): Provider[] {
  const cached = expansionCache.get(rows);
  if (cached) return cached;
  const expanded = expandProviders(rows);
  expansionCache.set(rows, expanded);
  return expanded;
}

export interface ProviderProtocolBinding {
  providerId: number;
  vendorId: number | null;
  providerType: ProviderType;
  url: string;
  isEnabled: boolean;
  protocol: ProviderProtocol;
}

export interface ProviderBindingRow {
  id: number;
  providerVendorId: number | null;
  providerType: ProviderType;
  url: string;
  isEnabled: boolean;
  protocols?: unknown;
  protocolUrls?: unknown;
}

/** (vendor, effective type, url) bindings of a row, one per served protocol. */
export function expandProviderBindingsForRow(row: ProviderBindingRow): ProviderProtocolBinding[] {
  const primary = row.providerType;
  const protocols = normalizeProviderProtocols(primary, row.protocols);
  const protocolUrls = normalizeProviderProtocolUrls(primary, protocols, row.protocolUrls);
  return protocols.map((protocol) => ({
    providerId: row.id,
    vendorId: row.providerVendorId,
    providerType: effectiveProviderTypeForProtocol(primary, protocol),
    url: resolveProtocolUrl({ providerType: primary, url: row.url, protocolUrls }, protocol),
    isEnabled: row.isEnabled,
    protocol,
  }));
}

export function expandProviderBindings(
  rows: readonly ProviderBindingRow[]
): ProviderProtocolBinding[] {
  return rows.flatMap((row) => expandProviderBindingsForRow(row));
}

/**
 * Keep exactly one instance per provider id for a request format:
 * the instance serving the format if any, otherwise the first (primary) instance,
 * so rows that do not serve the format are still reported as format mismatches.
 */
export function narrowInstancesForFormat(
  instances: readonly Provider[],
  format: ProviderProtocol | null | undefined
): Provider[] {
  const chosen = new Map<number, Provider>();
  const order: number[] = [];
  for (const instance of instances) {
    const current = chosen.get(instance.id);
    if (!current) {
      chosen.set(instance.id, instance);
      order.push(instance.id);
      continue;
    }
    if (format && instanceProtocol(current) !== format && instanceProtocol(instance) === format) {
      chosen.set(instance.id, instance);
    }
  }
  return order.map((id) => chosen.get(id) as Provider);
}

/** The instance of a provider id for a request format (falls back to the first instance). */
export function findInstanceForFormat(
  instances: readonly Provider[],
  providerId: number,
  format: ProviderProtocol | null | undefined
): Provider | null {
  let fallback: Provider | null = null;
  for (const instance of instances) {
    if (instance.id !== providerId) continue;
    if (!format || instanceProtocol(instance) === format) {
      return instance;
    }
    fallback ??= instance;
  }
  return fallback;
}
