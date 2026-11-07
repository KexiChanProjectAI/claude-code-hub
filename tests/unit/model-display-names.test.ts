import { describe, expect, it } from "vitest";
import { disambiguateDisplayNames } from "@/lib/model-display-names";

type Row = { id: string; name: string };
function run(rows: Row[]): string[] {
  disambiguateDisplayNames(
    rows,
    (row) => row.id,
    (row) => row.name,
    (row, name) => {
      row.name = name;
    }
  );
  return rows.map((row) => row.name);
}

describe("disambiguateDisplayNames", () => {
  it("adds the namespace to prefixed ids that share a name and keeps the plain one", () => {
    expect(
      run([
        { id: "daily/gpt-6-sol", name: "GPT-6-Sol" },
        { id: "gpt-6-sol", name: "GPT-6-Sol" },
        { id: "openai/test/gpt-6-sol", name: "GPT-6-Sol" },
      ])
    ).toEqual(["GPT-6-Sol (daily)", "GPT-6-Sol", "GPT-6-Sol (openai/test)"]);
  });

  it("leaves unique names alone, even for prefixed ids", () => {
    expect(
      run([
        { id: "daily/gpt-6.1-sol", name: "GPT-6.1-Sol" },
        { id: "gpt-6-luna", name: "GPT-6-Luna" },
      ])
    ).toEqual(["GPT-6.1-Sol", "GPT-6-Luna"]);
  });

  it("falls back to the id when names still collide", () => {
    expect(
      run([
        { id: "a", name: "Same" },
        { id: "b", name: "Same" },
        { id: "x/c", name: "Same (x)" },
        { id: "x/d", name: "Same" },
      ])
    ).toEqual(["a", "b", "x/c", "x/d"]);
  });

  it("handles an empty list", () => {
    expect(run([])).toEqual([]);
  });
});
