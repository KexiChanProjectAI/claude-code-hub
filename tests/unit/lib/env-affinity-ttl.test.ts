import { describe, expect, test } from "vitest";
import { EnvSchema } from "@/lib/config/env.schema";

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

describe("EnvSchema - sticky affinity TTLs", () => {
  test("defaults both sticky TTLs to 7 days", () => {
    const env = EnvSchema.parse({});
    expect(env.SESSION_BINDING_TTL_SECONDS).toBe(SEVEN_DAYS_SECONDS);
    expect(env.PREFIX_AFFINITY_TTL_SECONDS).toBe(SEVEN_DAYS_SECONDS);
  });

  test("keeps SESSION_TTL independent from the binding TTL", () => {
    const env = EnvSchema.parse({ SESSION_TTL: "300" });
    expect(env.SESSION_TTL).toBe(300);
    expect(env.SESSION_BINDING_TTL_SECONDS).toBe(SEVEN_DAYS_SECONDS);
  });

  test.each(["SESSION_BINDING_TTL_SECONDS", "PREFIX_AFFINITY_TTL_SECONDS"] as const)(
    "%s accepts explicit values inside bounds",
    (name) => {
      expect(EnvSchema.parse({ [name]: "3600" })[name]).toBe(3600);
      expect(EnvSchema.parse({ [name]: "2592000" })[name]).toBe(2_592_000);
    }
  );

  test.each(["SESSION_BINDING_TTL_SECONDS", "PREFIX_AFFINITY_TTL_SECONDS"] as const)(
    "%s rejects values outside bounds",
    (name) => {
      expect(() => EnvSchema.parse({ [name]: "59" })).toThrow();
      expect(() => EnvSchema.parse({ [name]: "2592001" })).toThrow();
    }
  );
});
