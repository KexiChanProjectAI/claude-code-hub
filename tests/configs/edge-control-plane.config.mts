import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "edge-control-plane",
  environment: "node",
  testFiles: ["tests/unit/edge/**/*.test.ts", "tests/unit/proxy/edge-settlement-parity.test.ts"],
  sourceFiles: ["src/app/v1/_lib/edge/**/*.ts"],
  thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
});
