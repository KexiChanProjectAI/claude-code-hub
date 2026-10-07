import type { Mock } from "vitest";
import { describe, expect, test, vi } from "vitest";

function queryRows(rows: unknown[], error?: unknown) {
  const query = {
    from: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => (error ? Promise.reject(error) : Promise.resolve(rows))),
  };
  return query;
}

const row = {
  id: 1,
  siteTitle: "Existing settings",
  allowGlobalUsageView: false,
  currencyDisplay: "USD",
  billingModelSource: "original",
  createdAt: new Date("2026-01-04T00:00:00.000Z"),
  updatedAt: new Date("2026-01-04T00:00:00.000Z"),
};

function mockDatabase(select: Mock, update = vi.fn()) {
  vi.doMock("@/drizzle/db", () => ({
    db: { select, update, insert: vi.fn(), execute: vi.fn(async () => ({ count: 0 })) },
  }));
}

// Each case reloads the repository after installing a different database mock.
// Static imports would bind it before that module-loading boundary.
describe("SystemSettings missing-column compatibility", () => {
  test("fails rather than silently initializing when no readable schema remains", async () => {
    vi.resetModules();
    mockDatabase(vi.fn(() => queryRows([], { code: "42703" })));
    const { getSystemSettings } = await import("@/repository/system-config");
    await expect(getSystemSettings()).rejects.toMatchObject({ code: "42703" });
  });

  test("preserves existing settings when the new memory column is absent", async () => {
    vi.resetModules();
    mockDatabase(
      vi.fn((selection: Record<string, unknown>) =>
        "enableMemoryAdmission" in selection
          ? queryRows([], { code: "42703" })
          : queryRows([{ ...row, edgeExecutionEnabled: true, enableHighConcurrencyMode: true }])
      )
    );
    const { getSystemSettings } = await import("@/repository/system-config");
    const result = await getSystemSettings();
    expect(result.siteTitle).toBe(row.siteTitle);
    expect(result.edgeExecutionEnabled).toBe(true);
    expect(result.enableHighConcurrencyMode).toBe(true);
    expect(result.enableMemoryAdmission).toBe(false);
  });

  test("preserves existing settings when only the agent catalog notes column is absent", async () => {
    vi.resetModules();
    mockDatabase(
      vi.fn((selection: Record<string, unknown>) =>
        "agentCatalogNotes" in selection
          ? queryRows([], { code: "42703" })
          : queryRows([{ ...row, enableMemoryAdmission: true }])
      )
    );
    const { getSystemSettings } = await import("@/repository/system-config");
    const result = await getSystemSettings();
    expect(result.siteTitle).toBe(row.siteTitle);
    expect(result.enableMemoryAdmission).toBe(true);
    expect(result.agentCatalogNotes).toBeNull();
  });

  test("reads and normalizes agent catalog notes", async () => {
    vi.resetModules();
    let written: Record<string, unknown> = {};
    const update = vi.fn(() => {
      const query = {
        set: vi.fn((input: Record<string, unknown>) => {
          written = input;
          return query;
        }),
        where: vi.fn(() => query),
        returning: vi.fn(() => Promise.resolve([{ ...row, ...written }])),
      };
      return query;
    });
    mockDatabase(
      vi.fn(() => queryRows([{ ...row, agentCatalogNotes: "## Notes" }])),
      update
    );
    const { getSystemSettings, updateSystemSettings } = await import("@/repository/system-config");
    expect((await getSystemSettings()).agentCatalogNotes).toBe("## Notes");

    const saved = await updateSystemSettings({ agentCatalogNotes: "Prefer Sonnet." });
    expect(written.agentCatalogNotes).toBe("Prefer Sonnet.");
    expect(saved.agentCatalogNotes).toBe("Prefer Sonnet.");

    const cleared = await updateSystemSettings({ agentCatalogNotes: "   " });
    expect(written.agentCatalogNotes).toBeNull();
    expect(cleared.agentCatalogNotes).toBeNull();
  });

  test("updates existing fields when the agent catalog notes column is absent", async () => {
    vi.resetModules();
    const update = vi.fn(() => {
      let values: Record<string, unknown> = {};
      const query = {
        set: vi.fn((input: Record<string, unknown>) => {
          values = input;
          return query;
        }),
        where: vi.fn(() => query),
        returning: vi.fn((selection: Record<string, unknown>) =>
          "agentCatalogNotes" in selection
            ? Promise.reject({ code: "42703" })
            : Promise.resolve([{ ...row, ...values }])
        ),
      };
      return query;
    });
    mockDatabase(
      vi.fn(() => queryRows([row])),
      update
    );
    const { updateSystemSettings } = await import("@/repository/system-config");
    const result = await updateSystemSettings({
      siteTitle: "Changed",
      agentCatalogNotes: "dropped on old schema",
    });
    expect(result.siteTitle).toBe("Changed");
    expect(result.agentCatalogNotes).toBeNull();
  });

  test("reports a migration requirement when no writable schema remains", async () => {
    vi.resetModules();
    const update = vi.fn(() => {
      const query = {
        set: vi.fn(() => query),
        where: vi.fn(() => query),
        returning: vi.fn(() => Promise.reject({ code: "42703" })),
      };
      return query;
    });
    mockDatabase(
      vi.fn(() => queryRows([row])),
      update
    );
    const { updateSystemSettings } = await import("@/repository/system-config");
    await expect(updateSystemSettings({ siteTitle: "Changed" })).rejects.toThrow(
      "system_settings 表列缺失，请执行数据库迁移以升级数据库结构。"
    );
  });

  test("updates existing fields when the memory admission column is absent", async () => {
    vi.resetModules();
    const update = vi.fn(() => {
      let values: Record<string, unknown> = {};
      const query = {
        set: vi.fn((input: Record<string, unknown>) => {
          values = input;
          return query;
        }),
        where: vi.fn(() => query),
        returning: vi.fn((selection: Record<string, unknown>) =>
          "enableMemoryAdmission" in selection
            ? Promise.reject({ code: "42703" })
            : Promise.resolve([{ ...row, ...values }])
        ),
      };
      return query;
    });
    mockDatabase(
      vi.fn(() => queryRows([row])),
      update
    );
    const { updateSystemSettings } = await import("@/repository/system-config");
    const result = await updateSystemSettings({ siteTitle: "Changed", edgeExecutionEnabled: true });
    expect(result.siteTitle).toBe("Changed");
    expect(result.edgeExecutionEnabled).toBe(true);
    expect(result.enableMemoryAdmission).toBe(false);
  });

  test("continues after a missing-column attempt returns no row", async () => {
    vi.resetModules();
    let attempt = 0;
    const update = vi.fn(() => {
      const query = {
        set: vi.fn(() => query),
        where: vi.fn(() => query),
        returning: vi.fn(() => {
          attempt++;
          if (attempt === 1) return Promise.reject({ code: "42703" });
          if (attempt === 2) return Promise.resolve([]);
          return Promise.resolve([{ ...row, siteTitle: "Empty then hit" }]);
        }),
      };
      return query;
    });
    mockDatabase(
      vi.fn(() => queryRows([row])),
      update
    );
    const { updateSystemSettings } = await import("@/repository/system-config");
    expect((await updateSystemSettings({ siteTitle: "Empty then hit" })).siteTitle).toBe(
      "Empty then hit"
    );
  });
});
