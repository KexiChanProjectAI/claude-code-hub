import { describe, expect, test, vi } from "vitest";
import type { Context } from "hono";

const mockValidateApiKeyAndGetUser = vi.fn();
const mockParseHonoJsonBody = vi.fn();

vi.mock("@/repository/key", () => ({
  validateApiKeyAndGetUser: (...args: unknown[]) => mockValidateApiKeyAndGetUser(...args),
}));

vi.mock("@/lib/api/v1/_shared/request-body", () => ({
  parseHonoJsonBody: (...args: unknown[]) => mockParseHonoJsonBody(...args),
}));

function createMockContext(): Context {
  return {
    req: {
      url: "http://localhost/api/v1/keys:validate",
    },
    get: vi.fn(),
  } as unknown as Context;
}

describe("validateKey handler", () => {
  test("returns owner and name for an active key", async () => {
    const { validateKey } = await import("@/app/api/v1/resources/keys/handlers");

    mockParseHonoJsonBody.mockResolvedValue({
      ok: true,
      data: { key: "sk-active-key" },
    });
    mockValidateApiKeyAndGetUser.mockResolvedValue({
      user: {
        id: 1,
        name: "testuser",
        isEnabled: true,
        expiresAt: null,
      },
      key: { id: 10, name: "default-key" },
    });

    const response = await validateKey(createMockContext());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ owner: "testuser", name: "default-key" });
  });

  test("returns 404 when key is not found", async () => {
    const { validateKey } = await import("@/app/api/v1/resources/keys/handlers");

    mockParseHonoJsonBody.mockResolvedValue({
      ok: true,
      data: { key: "sk-missing-key" },
    });
    mockValidateApiKeyAndGetUser.mockResolvedValue(null);

    const response = await validateKey(createMockContext());

    expect(response.status).toBe(404);
  });

  test("returns 404 when owning user is disabled", async () => {
    const { validateKey } = await import("@/app/api/v1/resources/keys/handlers");

    mockParseHonoJsonBody.mockResolvedValue({
      ok: true,
      data: { key: "sk-disabled-user-key" },
    });
    mockValidateApiKeyAndGetUser.mockResolvedValue({
      user: {
        id: 2,
        name: "disableduser",
        isEnabled: false,
        expiresAt: null,
      },
      key: { id: 20, name: "disabled-user-key" },
    });

    const response = await validateKey(createMockContext());

    expect(response.status).toBe(404);
  });

  test("returns 404 when owning user is expired", async () => {
    const { validateKey } = await import("@/app/api/v1/resources/keys/handlers");

    mockParseHonoJsonBody.mockResolvedValue({
      ok: true,
      data: { key: "sk-expired-user-key" },
    });
    mockValidateApiKeyAndGetUser.mockResolvedValue({
      user: {
        id: 3,
        name: "expireduser",
        isEnabled: true,
        expiresAt: new Date(Date.now() - 86_400_000),
      },
      key: { id: 30, name: "expired-user-key" },
    });

    const response = await validateKey(createMockContext());

    expect(response.status).toBe(404);
  });
});
