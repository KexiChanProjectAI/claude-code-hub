import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCollectGaugeSnapshot } = vi.hoisted(() => ({
  mockCollectGaugeSnapshot: vi.fn(),
}));

vi.mock("@/lib/metrics/gauges", () => ({
  collectGaugeSnapshot: mockCollectGaugeSnapshot,
}));

import { resetCchMetricsForTests } from "@/lib/metrics";
import { GET } from "./route";

describe("GET /metrics", () => {
  const originalEnabled = process.env.METRICS_ENABLED;
  const originalToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    resetCchMetricsForTests();
    mockCollectGaugeSnapshot.mockReset();
    mockCollectGaugeSnapshot.mockResolvedValue({
      concurrentSessions: 1,
      sessionsByUser: [],
      sessionsByProvider: [],
      inFlight: [],
    });
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_ENABLED;
  });

  afterEach(() => {
    resetCchMetricsForTests();
    if (originalEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = originalEnabled;
    if (originalToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalToken;
  });

  it("returns 404 when disabled", async () => {
    process.env.METRICS_ENABLED = "false";
    const response = await GET(new Request("http://localhost/metrics"));
    expect(response.status).toBe(404);
  });

  it("returns 401 when the scrape token does not match", async () => {
    process.env.METRICS_TOKEN = "secret";
    const response = await GET(new Request("http://localhost/metrics"));
    expect(response.status).toBe(401);
  });

  it("renders prometheus text after applying gauges", async () => {
    const response = await GET(new Request("http://localhost/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("cch_concurrent_sessions 1");
    expect(mockCollectGaugeSnapshot).toHaveBeenCalledTimes(1);
  });
});
