import { describe, expect, it } from "vitest";

import enDashboard from "../../../messages/en/dashboard.json";
import en from "../../../messages/en/modelCatalog.json";
import enMyUsage from "../../../messages/en/myUsage.json";
import jaDashboard from "../../../messages/ja/dashboard.json";
import ja from "../../../messages/ja/modelCatalog.json";
import jaMyUsage from "../../../messages/ja/myUsage.json";
import ruDashboard from "../../../messages/ru/dashboard.json";
import ru from "../../../messages/ru/modelCatalog.json";
import ruMyUsage from "../../../messages/ru/myUsage.json";
import zhCNDashboard from "../../../messages/zh-CN/dashboard.json";
import zhCN from "../../../messages/zh-CN/modelCatalog.json";
import zhCNMyUsage from "../../../messages/zh-CN/myUsage.json";
import zhTWDashboard from "../../../messages/zh-TW/dashboard.json";
import zhTW from "../../../messages/zh-TW/modelCatalog.json";
import zhTWMyUsage from "../../../messages/zh-TW/myUsage.json";

function extractKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj)
    .flatMap(([key, value]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? extractKeys(value as Record<string, unknown>, fullKey)
        : [fullKey];
    })
    .sort();
}

const catalogs: Record<string, Record<string, unknown>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ru,
};

describe("modelCatalog messages", () => {
  const baseline = extractKeys(en);

  for (const [locale, messages] of Object.entries(catalogs)) {
    it(`${locale} has the same keys as en with non-empty values`, () => {
      expect(extractKeys(messages)).toEqual(baseline);
      for (const key of baseline) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages);
        expect(typeof value === "string" && value.trim().length > 0, `${locale}:${key}`).toBe(true);
      }
    });
  }

  it("defines the navigation and my-usage entry labels in every locale", () => {
    for (const dashboard of [enDashboard, zhCNDashboard, zhTWDashboard, jaDashboard, ruDashboard]) {
      expect(dashboard.nav.models).toBeTruthy();
    }
    for (const myUsage of [enMyUsage, zhCNMyUsage, zhTWMyUsage, jaMyUsage, ruMyUsage]) {
      expect(myUsage.header.modelCatalog).toBeTruthy();
    }
  });
});
