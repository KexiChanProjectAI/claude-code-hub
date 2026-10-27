import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/cch-config-sync.test.ts",
      "tests/integration/cch-config-sync-postgres.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["scripts/sync-cch-config.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "/tmp/cch-config-sync-coverage",
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
