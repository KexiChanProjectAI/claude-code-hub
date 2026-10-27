import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "session-request-body-dedup",
  environment: "node",
  testFiles: [
    "tests/unit/compression/payload-codec.test.ts",
    "src/lib/redis/eval-buffer.test.ts",
    "src/lib/session-detail-snapshots.test.ts",
    "src/lib/session-manager-request-body-dedup.test.ts",
  ],
  sourceFiles: ["src/lib/compression/payload-codec.ts", "src/lib/redis/eval-buffer.ts"],
  thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
