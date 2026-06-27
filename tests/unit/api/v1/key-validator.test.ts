import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Key } from "@/types/key";
import type { User } from "@/types/user";

const resolveApiKeyAuthOutcomeMock = vi.fn();

vi.mock("@/repository/key", () => ({
  resolveApiKeyAuthOutcome: (key: string) => resolveApiKeyAuthOutcomeMock(key),
}));

async function loadValidator() {
  const mod = await import("@/lib/api/v1/_shared/key-validator");
  return mod.validateKeyString;
}

function createKey(overrides: Partial<Key> = {}): Key {
  return {
    id: 1,
    userId: 42,
    key: "sk-test-key",
    name: "primary",
    isEnabled: true,
    expiresAt: null,
    canLoginWebUi: true,
    limit5hUsd: null,
    limit5hResetMode: "fixed",
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: null,
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    costResetAt: null,
    limitConcurrentSessions: null,
    providerGroup: null,
    cacheTtlPreference: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createUser(overrides: Partial<User> = {}): User {
  return {
    id: 42,
    name: "alice",
    description: null,
    role: "user",
    rpm: null,
    dailyQuota: null,
    providerGroup: null,
    limit5hUsd: null,
    limit5hResetMode: "fixed",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    costResetAt: null,
    limit5hCostResetAt: null,
    limitConcurrentSessions: null,
    dailyResetMode: "fixed",
    dailyResetTime: null,
    isEnabled: true,
    expiresAt: null,
    allowedClients: null,
    allowedModels: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveApiKeyAuthOutcomeMock.mockResolvedValue({ ok: false, reason: "not_found" });
});

describe("validateKeyString", () => {
  test("DB 判定 not_found 时返回 invalid_api_key", async () => {
    const validateKeyString = await loadValidator();

    const result = await validateKeyString("sk-missing");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("key_not_found");
    expect(resolveApiKeyAuthOutcomeMock).toHaveBeenCalledWith("sk-missing");
  });

  test("DB 判定 key_disabled 时返回 key_disabled", async () => {
    const validateKeyString = await loadValidator();
    resolveApiKeyAuthOutcomeMock.mockResolvedValue({ ok: false, reason: "key_disabled" });

    const result = await validateKeyString("sk-disabled");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("key_disabled");
  });

  test("DB 判定 key_expired 时返回 key_expired", async () => {
    const validateKeyString = await loadValidator();
    resolveApiKeyAuthOutcomeMock.mockResolvedValue({ ok: false, reason: "key_expired" });

    const result = await validateKeyString("sk-expired");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("key_expired");
  });

  test("key 有效但用户 disabled 时返回 user_disabled", async () => {
    const validateKeyString = await loadValidator();
    resolveApiKeyAuthOutcomeMock.mockResolvedValue({
      ok: true,
      key: createKey(),
      user: createUser({ isEnabled: false }),
    });

    const result = await validateKeyString("sk-user-disabled");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("user_disabled");
  });

  test("key 有效但用户 expired 时返回 user_expired", async () => {
    const validateKeyString = await loadValidator();
    const past = new Date(Date.now() - 86_400_000);
    resolveApiKeyAuthOutcomeMock.mockResolvedValue({
      ok: true,
      key: createKey(),
      user: createUser({ expiresAt: past }),
    });

    const result = await validateKeyString("sk-user-expired");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("user_expired");
  });

  test("key 有效且用户有效时返回完整 key 与 owner", async () => {
    const validateKeyString = await loadValidator();
    const key = createKey({ name: "admin-test-key" });
    const user = createUser({ name: "bob", role: "admin" });
    resolveApiKeyAuthOutcomeMock.mockResolvedValue({ ok: true, key, user });

    const result = await validateKeyString("sk-valid");

    expect(result.valid).toBe(true);
    expect(result.reason).toBe("valid");
    expect(result).toMatchObject({ key, user });
  });

  test("resolveApiKeyAuthOutcome 抛异常时返回 server_error", async () => {
    const validateKeyString = await loadValidator();
    resolveApiKeyAuthOutcomeMock.mockRejectedValue(new Error("db down"));

    const result = await validateKeyString("sk-error");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("server_error");
  });
});
