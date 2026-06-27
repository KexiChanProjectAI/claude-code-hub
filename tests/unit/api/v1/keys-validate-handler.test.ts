import { beforeEach, describe, expect, test, vi } from "vitest";
import { validateApiKey } from "@/app/api/v1/resources/keys/handlers";

const validateKeyStringMock = vi.hoisted(() => vi.fn());
const extractApiKeyFromHeadersMock = vi.hoisted(() => vi.fn());
const getLocaleMock = vi.hoisted(() => vi.fn().mockReturnValue("en"));
const getTranslationsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/v1/_shared/key-validator", () => ({
  validateKeyString: (key: string) => validateKeyStringMock(key),
}));

vi.mock("@/app/v1/_lib/proxy/auth-guard", () => ({
  extractApiKeyFromHeaders: (headers: Record<string, string | null>) =>
    extractApiKeyFromHeadersMock(headers),
}));

vi.mock("next-intl/server", () => ({
  getLocale: () => getLocaleMock(),
  getTranslations: () => getTranslationsMock(),
}));

function createMockContext({
  body,
  headers = {},
  url = "http://localhost/api/v1/keys:validate",
}: {
  body: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  url?: string;
}) {
  const allHeaders = { "content-type": "application/json", ...headers };
  const headerMap = new Map(Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  return {
    req: {
      url,
      json: async () => body,
      header: (name: string) => allHeaders[name.toLowerCase()],
      raw: {
        headers: {
          get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
        },
      },
    },
  } as never;
}

function createValidOutcome() {
  return {
    valid: true,
    reason: "valid" as const,
    key: {
      id: 7,
      name: "admin-test-key",
      isEnabled: true,
      expiresAt: null,
    },
    user: {
      id: 9,
      name: "bob",
      role: "admin",
      isEnabled: true,
      expiresAt: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  validateKeyStringMock.mockResolvedValue({
    valid: false,
    reason: "invalid_api_key" as const,
  });
  extractApiKeyFromHeadersMock.mockReturnValue(null);
  getLocaleMock.mockReturnValue("en");
  getTranslationsMock.mockResolvedValue((code: string) => code);
});

describe("validateApiKey handler", () => {
  test("请求体提供 key 时校验并返回 valid=false 结果", async () => {
    validateKeyStringMock.mockResolvedValue({
      valid: false,
      reason: "key_not_found" as const,
    });

    const response = await validateApiKey(createMockContext({ body: { key: "sk-body-longer" } }));

    expect(response.status).toBe(200);
    expect(validateKeyStringMock).toHaveBeenCalledWith("sk-body-longer");
    const json = await response.json();
    expect(json).toMatchObject({
      valid: false,
      reason: "key_not_found",
      maskedKey: "sk-b••••••nger",
    });
    expect(json.key).toBeUndefined();
  });

  test("支持从 Authorization 头部提取 key", async () => {
    extractApiKeyFromHeadersMock.mockReturnValue("sk-header");
    validateKeyStringMock.mockResolvedValue(createValidOutcome());

    const response = await validateApiKey(
      createMockContext({
        body: {},
        headers: { authorization: "Bearer sk-header" },
      })
    );

    expect(validateKeyStringMock).toHaveBeenCalledWith("sk-header");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.valid).toBe(true);
    expect(json.key.name).toBe("admin-test-key");
  });

  test("支持从 x-api-key 头部提取 key", async () => {
    extractApiKeyFromHeadersMock.mockReturnValue("sk-x-key");
    validateKeyStringMock.mockResolvedValue(createValidOutcome());

    const response = await validateApiKey(
      createMockContext({
        body: {},
        headers: { "x-api-key": "sk-x-key" },
      })
    );

    expect(validateKeyStringMock).toHaveBeenCalledWith("sk-x-key");
    expect(response.status).toBe(200);
  });

  test("请求体 key 为空字符串且头部也未提供时返回 400", async () => {
    const response = await validateApiKey(createMockContext({ body: {} }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.errorCode).toBe("key.validate.missing_input");
    expect(validateKeyStringMock).not.toHaveBeenCalled();
  });

  test("有效 key 返回 key 的 name 与 owner", async () => {
    validateKeyStringMock.mockResolvedValue(createValidOutcome());

    const response = await validateApiKey(createMockContext({ body: { key: "sk-valid-longer" } }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      valid: true,
      reason: "valid",
      maskedKey: "sk-v••••••nger",
      key: {
        id: 7,
        name: "admin-test-key",
        enabled: true,
        expiresAt: null,
      },
      user: {
        id: 9,
        name: "bob",
        role: "admin",
        enabled: true,
        expiresAt: null,
      },
    });
  });

  test("被禁用的 key 返回 valid=false 与原因，不返回 owner", async () => {
    validateKeyStringMock.mockResolvedValue({
      valid: false,
      reason: "key_disabled" as const,
    });

    const response = await validateApiKey(
      createMockContext({ body: { key: "sk-disabled-longer" } })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      valid: false,
      reason: "key_disabled",
      maskedKey: "sk-d••••••nger",
    });
    expect(json.user).toBeUndefined();
  });

  test("返回 no-store 缓存头", async () => {
    validateKeyStringMock.mockResolvedValue(createValidOutcome());

    const response = await validateApiKey(createMockContext({ body: { key: "sk-valid-longer" } }));

    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
