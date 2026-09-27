import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { providers, providerUpstreamQuotaSnapshots } from "@/drizzle/schema";
import type { UpstreamQuotaProbeTarget } from "@/lib/provider-upstream-quota/types";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

type SnapshotRow = typeof providerUpstreamQuotaSnapshots.$inferSelect;

function toDate(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

function toMs(date: Date | null): number | null {
  return date ? date.getTime() : null;
}

export function toUpstreamQuotaSnapshot(row: SnapshotRow): UpstreamQuotaSnapshot {
  return {
    providerId: row.providerId,
    probeType: row.probeType ?? null,
    windows: Array.isArray(row.windows) ? row.windows : [],
    planLevel: row.planLevel ?? null,
    credentialValid: row.credentialValid,
    lastError: row.lastError ?? null,
    lastErrorStatus: row.lastErrorStatus ?? null,
    fetchedAt: toMs(row.fetchedAt),
    probedAt: row.probedAt.getTime(),
    reactivePauseUntil: toMs(row.reactivePauseUntil),
    reactivePauseReason: row.reactivePauseReason ?? null,
  };
}

export async function upsertProviderUpstreamQuotaSnapshot(
  snapshot: UpstreamQuotaSnapshot
): Promise<void> {
  const values = {
    providerId: snapshot.providerId,
    probeType: snapshot.probeType,
    windows: snapshot.windows,
    planLevel: snapshot.planLevel,
    credentialValid: snapshot.credentialValid,
    lastError: snapshot.lastError,
    lastErrorStatus: snapshot.lastErrorStatus,
    fetchedAt: toDate(snapshot.fetchedAt),
    probedAt: new Date(snapshot.probedAt),
    reactivePauseUntil: toDate(snapshot.reactivePauseUntil),
    reactivePauseReason: snapshot.reactivePauseReason,
    updatedAt: new Date(),
  };
  const { providerId: _providerId, ...updates } = values;
  await db
    .insert(providerUpstreamQuotaSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: providerUpstreamQuotaSnapshots.providerId, set: updates });
}

export async function findProviderUpstreamQuotaSnapshots(
  providerIds?: number[]
): Promise<UpstreamQuotaSnapshot[]> {
  if (providerIds && providerIds.length === 0) return [];
  const query = db.select().from(providerUpstreamQuotaSnapshots);
  const rows = providerIds
    ? await query.where(inArray(providerUpstreamQuotaSnapshots.providerId, providerIds))
    : await query;
  return rows.map(toUpstreamQuotaSnapshot);
}

export async function deleteProviderUpstreamQuotaSnapshot(providerId: number): Promise<void> {
  await db
    .delete(providerUpstreamQuotaSnapshots)
    .where(eq(providerUpstreamQuotaSnapshots.providerId, providerId));
}

const PROBE_TARGET_COLUMNS = {
  id: providers.id,
  name: providers.name,
  url: providers.url,
  key: providers.key,
  proxyUrl: providers.proxyUrl,
  proxyFallbackToDirect: providers.proxyFallbackToDirect,
  customHeaders: providers.customHeaders,
  upstreamQuotaProbeType: providers.upstreamQuotaProbeType,
  upstreamQuotaProbeOptions: providers.upstreamQuotaProbeOptions,
};

function toProbeTarget(row: {
  id: number;
  name: string;
  url: string;
  key: string;
  proxyUrl: string | null;
  proxyFallbackToDirect: boolean | null;
  customHeaders: Record<string, string> | null;
  upstreamQuotaProbeType: UpstreamQuotaProbeTarget["upstreamQuotaProbeType"];
  upstreamQuotaProbeOptions: UpstreamQuotaProbeTarget["upstreamQuotaProbeOptions"];
}): UpstreamQuotaProbeTarget {
  return {
    ...row,
    proxyFallbackToDirect: row.proxyFallbackToDirect ?? false,
    customHeaders: row.customHeaders ?? null,
    upstreamQuotaProbeType: row.upstreamQuotaProbeType ?? "auto",
    upstreamQuotaProbeOptions: row.upstreamQuotaProbeOptions ?? null,
  };
}

/** Enabled, non-deleted providers that are not explicitly opted out of quota probing. */
export async function findUpstreamQuotaProbeTargets(): Promise<UpstreamQuotaProbeTarget[]> {
  const rows = await db
    .select(PROBE_TARGET_COLUMNS)
    .from(providers)
    .where(and(eq(providers.isEnabled, true), isNull(providers.deletedAt)));
  return rows.filter((row) => row.upstreamQuotaProbeType !== "none").map(toProbeTarget);
}

export async function findUpstreamQuotaProbeTargetById(
  providerId: number
): Promise<UpstreamQuotaProbeTarget | null> {
  const rows = await db
    .select(PROBE_TARGET_COLUMNS)
    .from(providers)
    .where(and(eq(providers.id, providerId), isNull(providers.deletedAt)))
    .limit(1);
  return rows[0] ? toProbeTarget(rows[0]) : null;
}
