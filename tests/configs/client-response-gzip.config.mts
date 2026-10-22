import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "client-response-gzip",
  environment: "node",
  testFiles: [
    "tests/unit/proxy/client-compression.test.ts",
    "tests/unit/app/v1/client-compression-route.test.ts",
  ],
  sourceFiles: ["src/app/v1/_lib/proxy/client-compression.ts"],
  thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
});
