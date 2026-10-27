import { describe, expect, it, vi } from "vitest";
import { evalBuffer, toReplyBuffer } from "./eval-buffer";

describe("evalBuffer", () => {
  it("sends EVAL through callBuffer with keys and args in order", async () => {
    const reply = [1, Buffer.from("body")];
    const callBuffer = vi.fn().mockResolvedValue(reply);

    await expect(evalBuffer({ callBuffer } as never, "return 1", 2, "k1", "k2", 5)).resolves.toBe(
      reply
    );
    expect(callBuffer).toHaveBeenCalledWith("EVAL", ["return 1", 2, "k1", "k2", 5]);
  });

  it("normalizes reply elements to Buffers", () => {
    const buffer = Buffer.from([0x28, 0xb5]);
    expect(toReplyBuffer(buffer)).toBe(buffer);
    expect(toReplyBuffer("text")).toEqual(Buffer.from("text"));
    expect(toReplyBuffer(null)).toBeNull();
    expect(toReplyBuffer(false)).toBeNull();
    expect(toReplyBuffer(1)).toBeNull();
  });
});
