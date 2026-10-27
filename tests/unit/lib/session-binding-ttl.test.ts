import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIGURED_SESSION_BINDING_TTL_SECONDS,
  resolveSessionBindingTtlSeconds,
} from "@/lib/session-binding-ttl";

describe("resolveSessionBindingTtlSeconds", () => {
  test("defaults to 7 days", () => {
    expect(DEFAULT_CONFIGURED_SESSION_BINDING_TTL_SECONDS).toBe(604_800);
    expect(resolveSessionBindingTtlSeconds(undefined)).toBe(604_800);
    expect(resolveSessionBindingTtlSeconds("")).toBe(604_800);
  });

  test("falls back to the default for invalid values", () => {
    expect(resolveSessionBindingTtlSeconds("abc")).toBe(604_800);
    expect(resolveSessionBindingTtlSeconds("0")).toBe(604_800);
    expect(resolveSessionBindingTtlSeconds("-5")).toBe(604_800);
  });

  test("uses explicit positive values", () => {
    expect(resolveSessionBindingTtlSeconds("3600")).toBe(3600);
  });
});
