import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthSession } from "@/lib/auth";

const validateAuthTokenMock = vi.hoisted(() => vi.fn());
const validateKeyStringMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, validateAuthToken: validateAuthTokenMock };
});

vi.mock("@/lib/api/v1/_shared/key-validator", () => ({
  validateKeyString: (key: string) => validateKeyStringMock(key),
}));

const { callV1Route } = await import("../test-utils");

const adminSession = {
  user: { id: 1, role: "admin", isEnabled: true },
  key: { id: 1, userId: 1, key: "admin-token", canLoginWebUi: true },
} as AuthSession;

const userSession = {
  user: { id: 2, role: "user", isEnabled: true },
  key: { id: 2, userId: 2, key: "user-token", canLoginWebUi: true },
} as AuthSession;

const headers = { Authorization: "Bearer admin-token" };

describe("POST /api/v1/keys:validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateAuthTokenMock.mockResolvedValue(adminSession);
    validateKeyStringMock.mockResolvedValue({
      valid: false,
      reason: "key_not_found" as const,
    });
  });

  test("admin 可以访问并拿到校验结果", async () => {
    validateKeyStringMock.mockResolvedValue({
      valid: true,
      reason: "valid" as const,
      key: { id: 10, name: "probe", isEnabled: true, expiresAt: null },
      user: { id: 5, name: "alice", role: "user", isEnabled: true, expiresAt: null },
    });

    const { response, json } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/keys:validate",
      headers,
      body: { key: "sk-validate-longer" },
    });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      valid: true,
      reason: "valid",
      key: { id: 10, name: "probe" },
      user: { id: 5, name: "alice" },
    });
    expect(validateKeyStringMock).toHaveBeenCalledWith("sk-validate-longer");
  });

  test("非 admin 用户应被禁止访问", async () => {
    validateAuthTokenMock.mockResolvedValue(userSession);

    const { response } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/keys:validate",
      headers: { Authorization: "Bearer user-token" },
      body: { key: "sk-validate-longer" },
    });

    expect(response.status).toBe(403);
    expect(validateKeyStringMock).not.toHaveBeenCalled();
  });

  test("无效 key 返回 valid=false", async () => {
    const { response, json } = await callV1Route({
      method: "POST",
      pathname: "/api/v1/keys:validate",
      headers,
      body: { key: "sk-validate-longer" },
    });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      valid: false,
      reason: "key_not_found",
      maskedKey: expect.any(String),
    });
  });

  test("OpenAPI 文档包含新端点", async () => {
    const { response, json } = await callV1Route({
      method: "GET",
      pathname: "/api/v1/openapi.json",
      headers,
    });

    expect(response.status).toBe(200);
    expect(json).toHaveProperty("paths./api/v1/keys:validate");
  });
});
