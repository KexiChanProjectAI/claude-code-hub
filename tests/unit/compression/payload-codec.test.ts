// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

const envState = vi.hoisted(() => ({ level: 1 as unknown, throws: false }));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => {
    if (envState.throws) throw new Error("env unavailable");
    return { SESSION_PAYLOAD_ZSTD_LEVEL: envState.level };
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

function largeJson(entries: number): string {
  return JSON.stringify({
    messages: Array.from({ length: entries }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with enough repeated filler text to be worth compressing`,
    })),
  });
}

beforeEach(async () => {
  vi.resetModules();
  envState.level = 1;
  envState.throws = false;
  mockLoggerWarn.mockClear();
  const { resetPayloadCodecWarnings } = await import("@/lib/compression/payload-codec");
  resetPayloadCodecWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payload codec", () => {
  it("round-trips a large payload and actually shrinks it", async () => {
    const { compressPayload, decompressPayload, isCompressedPayload } = await import(
      "@/lib/compression/payload-codec"
    );
    const original = largeJson(2000);

    const stored = await compressPayload(original);
    expect(isCompressedPayload(stored)).toBe(true);
    expect(stored.length).toBeLessThan(original.length / 2);
    await expect(decompressPayload(stored)).resolves.toBe(original);
  });

  it("round-trips multibyte text and a multi-megabyte body", async () => {
    const { compressPayload, decompressPayload } = await import("@/lib/compression/payload-codec");

    const multibyte = "界面响应体".repeat(20_000);
    await expect(decompressPayload(await compressPayload(multibyte))).resolves.toBe(multibyte);

    const huge = largeJson(60_000);
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
    await expect(decompressPayload(await compressPayload(huge))).resolves.toBe(huge);
  });

  it("passes short payloads through untouched", async () => {
    const { compressPayload, isCompressedPayload } = await import(
      "@/lib/compression/payload-codec"
    );
    const short = JSON.stringify({ model: "claude", messages: [{ role: "user" }] });

    const stored = await compressPayload(short);
    expect(stored).toBe(short);
    expect(isCompressedPayload(stored)).toBe(false);
    await expect(compressPayload("")).resolves.toBe("");
  });

  it("returns plaintext written by an older build untouched", async () => {
    const { decompressPayload } = await import("@/lib/compression/payload-codec");
    const legacy = largeJson(500);

    await expect(decompressPayload(legacy)).resolves.toBe(legacy);
    await expect(decompressPayload("event: message\ndata: {}\n\n")).resolves.toBe(
      "event: message\ndata: {}\n\n"
    );
  });

  it("does not mistake a body that merely starts with the label", async () => {
    const { isCompressedPayload, decompressPayload } = await import(
      "@/lib/compression/payload-codec"
    );
    const lookalike = `zst1:${"a".repeat(100)}`;

    expect(isCompressedPayload(lookalike)).toBe(false);
    await expect(decompressPayload(lookalike)).resolves.toBe(lookalike);
  });

  it("returns the original text and warns once when compression fails", async () => {
    vi.doMock("node:zlib", async () => {
      const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      return {
        ...actual,
        zstdCompress: (
          _buffer: Buffer,
          _options: unknown,
          callback: (error: Error | null, result?: Buffer) => void
        ) => callback(new Error("zstd unavailable")),
      };
    });

    // doMock 只影响此后重新求值的模块，必须先清空注册表再导入。
    vi.resetModules();
    const { compressPayload } = await import("@/lib/compression/payload-codec");
    const original = largeJson(2000);

    await expect(compressPayload(original)).resolves.toBe(original);
    await expect(compressPayload(original)).resolves.toBe(original);
    expect(
      mockLoggerWarn.mock.calls.filter(
        (call) => call[0] === "[Compression] Payload compression failed, storing raw"
      )
    ).toHaveLength(1);

    vi.doUnmock("node:zlib");
  });

  it("returns the envelope unchanged and warns when the payload is corrupt", async () => {
    const { decompressPayload, PAYLOAD_ENVELOPE_PREFIX } = await import(
      "@/lib/compression/payload-codec"
    );
    const corrupt = `${PAYLOAD_ENVELOPE_PREFIX}${Buffer.from("not really zstd").toString("base64")}`;

    await expect(decompressPayload(corrupt)).resolves.toBe(corrupt);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Compression] Payload decompression failed",
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it("defaults to zstd level 1 and honours a valid configured level", async () => {
    const codec = await import("@/lib/compression/payload-codec");
    expect(codec.getPayloadZstdLevel()).toBe(1);

    codec.resetPayloadCodecWarnings();
    envState.level = 7;
    expect(codec.getPayloadZstdLevel()).toBe(7);

    codec.resetPayloadCodecWarnings();
    envState.level = 99;
    expect(codec.getPayloadZstdLevel()).toBe(1);

    codec.resetPayloadCodecWarnings();
    envState.throws = true;
    expect(codec.getPayloadZstdLevel()).toBe(1);
  });
});

describe("binary payload codec", () => {
  it("stores raw zstd frames without base64 and round-trips them", async () => {
    const { compressPayloadBinary, decompressPayloadBinary, isZstdFrame } = await import(
      "@/lib/compression/payload-codec"
    );
    const original = largeJson(2000);

    const frame = await compressPayloadBinary(original);
    expect(isZstdFrame(frame)).toBe(true);
    expect(frame.length).toBeLessThan(Buffer.byteLength(original) / 4);
    await expect(decompressPayloadBinary(frame)).resolves.toBe(original);
  });

  it("keeps short payloads as plain UTF-8 bytes", async () => {
    const { compressPayloadBinary, decompressPayloadBinary, isZstdFrame } = await import(
      "@/lib/compression/payload-codec"
    );
    const short = "界面 short";

    const stored = await compressPayloadBinary(short);
    expect(isZstdFrame(stored)).toBe(false);
    expect(stored.toString("utf8")).toBe(short);
    await expect(decompressPayloadBinary(stored)).resolves.toBe(short);
    await expect(compressPayloadBinary("")).resolves.toEqual(Buffer.alloc(0));
  });

  it("reads legacy base64 envelopes, plaintext strings and null", async () => {
    const { compressPayload, decompressPayloadBinary } = await import(
      "@/lib/compression/payload-codec"
    );
    const original = largeJson(2000);
    const envelope = await compressPayload(original);

    await expect(decompressPayloadBinary(Buffer.from(envelope, "utf8"))).resolves.toBe(original);
    await expect(decompressPayloadBinary(envelope)).resolves.toBe(original);
    await expect(decompressPayloadBinary("plain")).resolves.toBe("plain");
    await expect(decompressPayloadBinary(null)).resolves.toBeNull();
    await expect(decompressPayloadBinary(undefined)).resolves.toBeNull();
  });

  it("returns null for corrupt frames and corrupt envelopes", async () => {
    const { decompressPayloadBinary, PAYLOAD_ENVELOPE_PREFIX } = await import(
      "@/lib/compression/payload-codec"
    );
    const corruptFrame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(8)]);
    const corruptEnvelope = `${PAYLOAD_ENVELOPE_PREFIX}${Buffer.from("junk").toString("base64")}`;

    await expect(decompressPayloadBinary(corruptFrame)).resolves.toBeNull();
    await expect(decompressPayloadBinary(corruptEnvelope)).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Compression] Payload decompression failed",
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it("compresses a near-duplicate multi-megabyte body to a tiny dictionary delta", async () => {
    const { compressPayloadBinary, decompressPayloadBinary, supportsZstdDictionary } = await import(
      "@/lib/compression/payload-codec"
    );
    expect(supportsZstdDictionary()).toBe(true);
    // 低内部重复的正文：独立压缩无法消除，字典能把整份重复引用掉。
    const messages = Array.from({ length: 3000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: (globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()).repeat(6),
    }));
    const base = JSON.stringify({ model: "a", messages });
    const variant = JSON.stringify({ model: "b", metadata: { user_id: "x" }, messages });
    expect(Buffer.byteLength(base)).toBeGreaterThan(1024 * 1024);
    const dictionary = Buffer.from(base, "utf8");

    const independent = await compressPayloadBinary(variant);
    const delta = await compressPayloadBinary(variant, { dictionary });
    expect(delta.length).toBeLessThan(2048);
    expect(delta.length).toBeLessThan(independent.length / 100);
    await expect(decompressPayloadBinary(delta, { dictionary })).resolves.toBe(variant);
    // 缺少字典时无法解码，返回 null 而不是错误正文。
    await expect(decompressPayloadBinary(delta)).resolves.toBeNull();
  });

  it("uses a dictionary even for short inputs", async () => {
    const { compressPayloadBinary, decompressPayloadBinary, isZstdFrame } = await import(
      "@/lib/compression/payload-codec"
    );
    const dictionary = Buffer.from(largeJson(2000), "utf8");
    const short = '{"model":"x"}';

    const frame = await compressPayloadBinary(short, { dictionary });
    expect(isZstdFrame(frame)).toBe(true);
    await expect(decompressPayloadBinary(frame, { dictionary })).resolves.toBe(short);
  });

  it("falls back to plaintext bytes and warns once when zstd fails", async () => {
    vi.doMock("node:zlib", async () => {
      const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      return {
        ...actual,
        zstdCompress: (
          _buffer: Buffer,
          _options: unknown,
          callback: (error: Error | null, result?: Buffer) => void
        ) => callback(new Error("zstd unavailable")),
      };
    });
    vi.resetModules();
    const { compressPayloadBinary } = await import("@/lib/compression/payload-codec");
    const original = largeJson(2000);
    const dictionary = Buffer.from(original, "utf8");

    // Buffer.equals 比逐元素 toEqual 快得多（正文约 130 KB）。
    expect((await compressPayloadBinary(original)).equals(Buffer.from(original))).toBe(true);
    expect(
      (await compressPayloadBinary(original, { dictionary })).equals(Buffer.from(original))
    ).toBe(true);
    expect((await compressPayloadBinary("tiny", { dictionary })).equals(Buffer.from("tiny"))).toBe(
      true
    );
    expect(
      mockLoggerWarn.mock.calls.filter(
        (call) => call[0] === "[Compression] Payload compression failed, storing raw"
      )
    ).toHaveLength(1);
    vi.doUnmock("node:zlib");
  });

  it("reports no dictionary support when zlib ignores the dictionary option", async () => {
    vi.doMock("node:zlib", async () => {
      const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      return {
        ...actual,
        // 模拟静默忽略 dictionary 选项的运行时：帧不引用字典，体积也降不下来。
        zstdCompressSync: (buffer: Buffer) => actual.zstdCompressSync(buffer),
        zstdDecompressSync: (buffer: Buffer) => actual.zstdDecompressSync(buffer),
      };
    });
    vi.resetModules();
    const { supportsZstdDictionary, compressPayloadBinary, isZstdFrame } = await import(
      "@/lib/compression/payload-codec"
    );

    expect(supportsZstdDictionary()).toBe(false);
    expect(supportsZstdDictionary()).toBe(false);
    const stored = await compressPayloadBinary("tiny", { dictionary: Buffer.from("dict") });
    expect(isZstdFrame(stored)).toBe(false);
    vi.doUnmock("node:zlib");
  });

  it("reports no dictionary support when the probe throws", async () => {
    vi.doMock("node:zlib", async () => {
      const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      return {
        ...actual,
        zstdCompressSync: () => {
          throw new Error("no zstd");
        },
      };
    });
    vi.resetModules();
    const { supportsZstdDictionary } = await import("@/lib/compression/payload-codec");
    expect(supportsZstdDictionary()).toBe(false);
    vi.doUnmock("node:zlib");
  });
});
