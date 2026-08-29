import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { messageRequest, providers } from "@/drizzle/schema";
import { logger } from "@/lib/logger";
import {
  getUserActiveSessionsScanPattern,
  parseUserIdFromActiveSessionsKey,
} from "@/lib/redis/active-session-keys";
import { getRedisClient } from "@/lib/redis/client";
import { scanPattern } from "@/lib/redis/scan-helper";
import { SessionTracker } from "@/lib/session-tracker";
import { findAllProviders } from "@/repository/provider";

export type GaugeSnapshot = {
  concurrentSessions: number;
  sessionsByUser: Array<{ userId: number; count: number }>;
  sessionsByProvider: Array<{ providerId: number; providerName: string; count: number }>;
  inFlight: Array<{ userId: number; model: string | null; providerId: number; count: number }>;
};

const EMPTY_SNAPSHOT: GaugeSnapshot = {
  concurrentSessions: 0,
  sessionsByUser: [],
  sessionsByProvider: [],
  inFlight: [],
};

async function collectUserSessionCounts(): Promise<Array<{ userId: number; count: number }>> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return [];

  const keys = await scanPattern(redis, getUserActiveSessionsScanPattern(), 100);
  const userIds: number[] = [];
  for (const key of keys) {
    const userId = parseUserIdFromActiveSessionsKey(key);
    if (userId != null) userIds.push(userId);
  }
  if (userIds.length === 0) return [];

  const counts = await Promise.all(
    userIds.map(async (userId) => ({
      userId,
      count: await SessionTracker.getUserSessionCount(userId),
    }))
  );
  return counts.filter((row) => row.count > 0);
}

async function collectProviderSessionCounts(): Promise<
  Array<{ providerId: number; providerName: string; count: number }>
> {
  const enabled = (await findAllProviders()).filter((provider) => provider.isEnabled);
  if (enabled.length === 0) return [];

  const counts = await SessionTracker.getProviderSessionCountBatch(
    enabled.map((provider) => provider.id)
  );
  return enabled.map((provider) => ({
    providerId: provider.id,
    providerName: provider.name,
    count: counts.get(provider.id) ?? 0,
  }));
}

async function collectInFlight(): Promise<
  Array<{ userId: number; model: string | null; providerId: number; count: number }>
> {
  const rows = await db
    .select({
      userId: messageRequest.userId,
      model: messageRequest.model,
      providerId: messageRequest.providerId,
      count: sql<number>`count(*)::int`,
    })
    .from(messageRequest)
    .innerJoin(providers, eq(messageRequest.providerId, providers.id))
    .where(
      and(
        isNull(messageRequest.deletedAt),
        isNull(messageRequest.statusCode),
        sql`${messageRequest.createdAt} >= now() - interval '24 hours'`,
        eq(messageRequest.isReplay, false),
        sql`(${messageRequest.blockedBy} IS NULL OR ${messageRequest.blockedBy} <> 'warmup')`,
        isNull(providers.deletedAt)
      )
    )
    .groupBy(messageRequest.userId, messageRequest.model, messageRequest.providerId);

  return rows.map((row) => ({
    userId: row.userId,
    model: row.model,
    providerId: row.providerId,
    count: Number(row.count) || 0,
  }));
}

export async function collectGaugeSnapshot(): Promise<GaugeSnapshot> {
  const [sessionsResult, usersResult, providersResult, inFlightResult] = await Promise.allSettled([
    SessionTracker.getObservedGlobalSessionCount(),
    collectUserSessionCounts(),
    collectProviderSessionCounts(),
    collectInFlight(),
  ]);

  const snapshot: GaugeSnapshot = { ...EMPTY_SNAPSHOT };

  if (sessionsResult.status === "fulfilled") {
    snapshot.concurrentSessions = sessionsResult.value;
  } else {
    logger.warn("[metrics] Failed to collect concurrent sessions", {
      error:
        sessionsResult.reason instanceof Error
          ? sessionsResult.reason.message
          : String(sessionsResult.reason),
    });
  }

  if (usersResult.status === "fulfilled") {
    snapshot.sessionsByUser = usersResult.value;
  } else {
    logger.warn("[metrics] Failed to collect per-user sessions", {
      error:
        usersResult.reason instanceof Error
          ? usersResult.reason.message
          : String(usersResult.reason),
    });
  }

  if (providersResult.status === "fulfilled") {
    snapshot.sessionsByProvider = providersResult.value;
  } else {
    logger.warn("[metrics] Failed to collect per-provider sessions", {
      error:
        providersResult.reason instanceof Error
          ? providersResult.reason.message
          : String(providersResult.reason),
    });
  }

  if (inFlightResult.status === "fulfilled") {
    snapshot.inFlight = inFlightResult.value;
  } else {
    logger.warn("[metrics] Failed to collect in-flight requests", {
      error:
        inFlightResult.reason instanceof Error
          ? inFlightResult.reason.message
          : String(inFlightResult.reason),
    });
  }

  return snapshot;
}
