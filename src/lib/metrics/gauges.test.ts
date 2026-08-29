import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetObservedGlobalSessionCount,
  mockGetUserSessionCount,
  mockGetProviderSessionCountBatch,
  mockScanPattern,
  mockGetRedisClient,
  mockFindAllProviders,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockGetObservedGlobalSessionCount: vi.fn(),
  mockGetUserSessionCount: vi.fn(),
  mockGetProviderSessionCountBatch: vi.fn(),
  mockScanPattern: vi.fn(),
  mockGetRedisClient: vi.fn(),
  mockFindAllProviders: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    getObservedGlobalSessionCount: mockGetObservedGlobalSessionCount,
    getUserSessionCount: mockGetUserSessionCount,
    getProviderSessionCountBatch: mockGetProviderSessionCountBatch,
  },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mockGetRedisClient,
}));

vi.mock("@/lib/redis/scan-helper", () => ({
  scanPattern: mockScanPattern,
}));

vi.mock("@/repository/provider", () => ({
  findAllProviders: mockFindAllProviders,
}));

vi.mock("@/drizzle/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { parseUserIdFromActiveSessionsKey } from "@/lib/redis/active-session-keys";
import { collectGaugeSnapshot } from "./gauges";

describe("parseUserIdFromActiveSessionsKey", () => {
  it("parses user zset keys and rejects junk", () => {
    expect(parseUserIdFromActiveSessionsKey("{active_sessions}:user:42:active_sessions")).toBe(42);
    expect(parseUserIdFromActiveSessionsKey("{active_sessions}:key:42:active_sessions")).toBeNull();
  });
});

describe("collectGaugeSnapshot", () => {
  beforeEach(() => {
    mockGetObservedGlobalSessionCount.mockReset();
    mockGetUserSessionCount.mockReset();
    mockGetProviderSessionCountBatch.mockReset();
    mockScanPattern.mockReset();
    mockGetRedisClient.mockReset();
    mockFindAllProviders.mockReset();
    mockDbSelect.mockReset();
  });

  it("aggregates redis session counts and in-flight rows", async () => {
    mockGetObservedGlobalSessionCount.mockResolvedValue(7);
    mockGetRedisClient.mockReturnValue({ status: "ready" });
    mockScanPattern.mockResolvedValue([
      "{active_sessions}:user:12:active_sessions",
      "{active_sessions}:user:0:active_sessions",
    ]);
    mockGetUserSessionCount.mockResolvedValue(2);
    mockFindAllProviders.mockResolvedValue([
      { id: 5, name: "opus-pool", isEnabled: true },
      { id: 9, name: "off", isEnabled: false },
    ]);
    mockGetProviderSessionCountBatch.mockResolvedValue(new Map([[5, 3]]));
    mockDbSelect.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            groupBy: async () => [
              { userId: 12, model: "claude-sonnet-4", providerId: 5, count: 1 },
            ],
          }),
        }),
      }),
    });

    const snapshot = await collectGaugeSnapshot();
    expect(snapshot.concurrentSessions).toBe(7);
    expect(snapshot.sessionsByUser).toEqual([{ userId: 12, count: 2 }]);
    expect(snapshot.sessionsByProvider).toEqual([
      { providerId: 5, providerName: "opus-pool", count: 3 },
    ]);
    expect(snapshot.inFlight).toEqual([
      { userId: 12, model: "claude-sonnet-4", providerId: 5, count: 1 },
    ]);
  });

  it("degrades individual sources without throwing", async () => {
    mockGetObservedGlobalSessionCount.mockRejectedValue(new Error("redis down"));
    mockGetRedisClient.mockReturnValue(null);
    mockFindAllProviders.mockRejectedValue(new Error("db down"));
    mockDbSelect.mockImplementation(() => {
      throw new Error("query failed");
    });

    const snapshot = await collectGaugeSnapshot();
    expect(snapshot).toEqual({
      concurrentSessions: 0,
      sessionsByUser: [],
      sessionsByProvider: [],
      inFlight: [],
    });
  });
});
