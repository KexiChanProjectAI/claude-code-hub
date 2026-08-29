import { afterEach, describe, expect, it } from "vitest";
import { EnvSchema } from "@/lib/config/env.schema";
import { authorizeMetricsRequest, getMetricsToken, isMetricsEnabled } from "./config";

describe("EnvSchema metrics flags", () => {
  it("defaults metrics enabled with no token", () => {
    const env = EnvSchema.parse({});
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_TOKEN).toBeUndefined();
  });

  it("parses explicit disable", () => {
    expect(EnvSchema.parse({ METRICS_ENABLED: "false" }).METRICS_ENABLED).toBe(false);
    expect(EnvSchema.parse({ METRICS_ENABLED: "0" }).METRICS_ENABLED).toBe(false);
  });
});

describe("isMetricsEnabled", () => {
  const original = process.env.METRICS_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = original;
  });

  it("defaults to true", () => {
    delete process.env.METRICS_ENABLED;
    expect(isMetricsEnabled()).toBe(true);
  });

  it("honors false/0", () => {
    process.env.METRICS_ENABLED = "false";
    expect(isMetricsEnabled()).toBe(false);
    process.env.METRICS_ENABLED = "0";
    expect(isMetricsEnabled()).toBe(false);
  });
});

describe("authorizeMetricsRequest", () => {
  const original = process.env.METRICS_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = original;
  });

  it("allows all requests when no token is configured", () => {
    delete process.env.METRICS_TOKEN;
    expect(getMetricsToken()).toBeUndefined();
    expect(authorizeMetricsRequest(new Request("http://localhost/metrics"))).toBe(true);
  });

  it("accepts bearer and header tokens", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(
      authorizeMetricsRequest(
        new Request("http://localhost/metrics", {
          headers: { authorization: "Bearer secret-token" },
        })
      )
    ).toBe(true);
    expect(
      authorizeMetricsRequest(
        new Request("http://localhost/metrics", {
          headers: { "x-metrics-token": "secret-token" },
        })
      )
    ).toBe(true);
    expect(authorizeMetricsRequest(new Request("http://localhost/metrics"))).toBe(false);
    expect(
      authorizeMetricsRequest(
        new Request("http://localhost/metrics", {
          headers: { authorization: "Bearer other" },
        })
      )
    ).toBe(false);
  });
});
