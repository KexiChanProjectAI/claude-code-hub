import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  constants,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
} from "node:zlib";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";

const compressAsync = promisify(zstdCompress);
const decompressAsync = promisify(zstdDecompress);

/** 小于该阈值的载荷压缩收益抵不上编码开销，直接原样保留。 */
export const COMPRESS_MIN_BYTES = 16 * 1024;

/**
 * 信封前缀使用 US(0x1f) 控制符：JSON.stringify 输出不可能包含它，真实 SSE 正文也不会以它开头，
 * 因此前缀判定不存在歧义，旧版本写入的明文可以原样读回。
 */
export const PAYLOAD_ENVELOPE_PREFIX = `${String.fromCharCode(0x1f)}zst1:`;

/** zstd 帧魔数 0xFD2FB528（小端）。0xB5 不是合法的 UTF-8 起始字节，明文 JSON/SSE 不会与之冲突。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PAYLOAD_ENVELOPE_PREFIX_BYTES = Buffer.from(PAYLOAD_ENVELOPE_PREFIX, "utf8");

const DEFAULT_ZSTD_LEVEL = 1;
const BASE_WINDOW_LOG = 20;
const MAX_WINDOW_LOG = 27;
const MAX_DICTIONARY_HASH_LOG = 22;

let compressFailureLogged = false;
let decompressFailureLogged = false;
let cachedLevel: number | null = null;
let dictionarySupport: boolean | null = null;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 压缩等级由 SESSION_PAYLOAD_ZSTD_LEVEL 决定；配置不可用时退回最快的等级 1。 */
export function getPayloadZstdLevel(): number {
  if (cachedLevel !== null) return cachedLevel;
  let level = DEFAULT_ZSTD_LEVEL;
  try {
    const configured = getEnvConfig().SESSION_PAYLOAD_ZSTD_LEVEL;
    if (Number.isSafeInteger(configured) && configured >= 1 && configured <= 19) {
      level = configured;
    }
  } catch {
    level = DEFAULT_ZSTD_LEVEL;
  }
  cachedLevel = level;
  return level;
}

function baseParams(): Record<number, number> {
  return {
    [constants.ZSTD_c_compressionLevel]: getPayloadZstdLevel(),
    [constants.ZSTD_c_windowLog]: BASE_WINDOW_LOG,
  };
}

/**
 * 以字典压缩时，窗口必须覆盖“字典 + 输入”，否则字典大部分落在窗口之外；
 * hashLog 也需放大到 22，默认值只能索引字典的一小部分。实测（1.3-4.9 MiB 正文、几十字节差异）
 * 输出 190-540 字节。不开启长距离匹配：它在含重复片段的正文上会把差异放大到约 16 KiB。
 */
function dictionaryParams(dictionaryBytes: number, inputBytes: number): Record<number, number> {
  const span = Math.max(dictionaryBytes + inputBytes, 1);
  const windowLog = Math.min(Math.max(Math.ceil(Math.log2(span)), 10), MAX_WINDOW_LOG);
  return {
    [constants.ZSTD_c_compressionLevel]: getPayloadZstdLevel(),
    [constants.ZSTD_c_windowLog]: windowLog,
    [constants.ZSTD_c_hashLog]: Math.min(windowLog, MAX_DICTIONARY_HASH_LOG),
  };
}

/**
 * 运行时探测 zlib 是否真正使用 dictionary 选项：若忽略该选项，不带字典也能解压成功。
 * 结果按进程缓存，不支持时所有调用方退回独立压缩。
 */
export function supportsZstdDictionary(): boolean {
  if (dictionarySupport !== null) return dictionarySupport;
  try {
    // 随机字节不可自压缩：帧只有引用字典才能明显变小，避免自重复样本误判为“支持”。
    const dictionary = randomBytes(4096);
    const sample = Buffer.concat([dictionary, Buffer.from("tail", "utf8")]);
    const frame = zstdCompressSync(sample, {
      dictionary,
      params: dictionaryParams(dictionary.length, sample.length),
    } as Parameters<typeof zstdCompressSync>[1]);
    const decoded = zstdDecompressSync(frame, { dictionary } as Parameters<
      typeof zstdDecompressSync
    >[1]);
    if (!decoded.equals(sample) || frame.length >= sample.length / 2) {
      dictionarySupport = false;
      return false;
    }
    try {
      zstdDecompressSync(frame);
      dictionarySupport = false;
    } catch {
      dictionarySupport = true;
    }
  } catch {
    dictionarySupport = false;
  }
  return dictionarySupport;
}

export function isCompressedPayload(value: string): boolean {
  return typeof value === "string" && value.startsWith(PAYLOAD_ENVELOPE_PREFIX);
}

export function isZstdFrame(value: Buffer): boolean {
  return (
    value.length >= ZSTD_MAGIC.length && value.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
  );
}

/**
 * 压缩后以 base64 信封返回。始终走 zlib 异步 API（libuv 线程池），不阻塞事件循环。
 * 失败只记一次日志并返回原文，降级为当前行为而不是丢掉产物。
 * 仅用于必须保持字符串的内存/非 Redis 场景；Redis 留存请使用 compressPayloadBinary。
 */
export async function compressPayload(text: string): Promise<string> {
  if (typeof text !== "string" || text.length === 0) return text;
  if (Buffer.byteLength(text, "utf8") < COMPRESS_MIN_BYTES) return text;

  try {
    const encoded = await compressAsync(Buffer.from(text, "utf8"), { params: baseParams() });
    return `${PAYLOAD_ENVELOPE_PREFIX}${encoded.toString("base64")}`;
  } catch (error) {
    warnCompressFailure(error);
    return text;
  }
}

/** 非信封值原样返回，保证旧数据与低于阈值的数据无需迁移即可读回。 */
export async function decompressPayload(value: string): Promise<string> {
  if (!isCompressedPayload(value)) return value;

  try {
    const decoded = await decompressAsync(
      Buffer.from(value.slice(PAYLOAD_ENVELOPE_PREFIX.length), "base64")
    );
    return decoded.toString("utf8");
  } catch (error) {
    warnDecompressFailure(error);
    return value;
  }
}

export type BinaryPayloadOptions = {
  /** 用作 zstd 原始内容字典的未压缩正文。 */
  dictionary?: Buffer | null;
};

/**
 * Redis 留存专用：返回原始 zstd 帧（无 base64 膨胀）。低于阈值且无字典时直接返回 UTF-8 字节。
 * 字典压缩失败时退回独立压缩，独立压缩失败时退回明文字节，读取端都能按首字节识别。
 */
export async function compressPayloadBinary(
  text: string,
  options: BinaryPayloadOptions = {}
): Promise<Buffer> {
  const input = Buffer.from(typeof text === "string" ? text : "", "utf8");
  const dictionary = options.dictionary ?? null;
  const useDictionary = dictionary !== null && dictionary.length > 0 && supportsZstdDictionary();

  if (input.length === 0) return input;
  if (!useDictionary && input.length < COMPRESS_MIN_BYTES) return input;

  if (useDictionary) {
    try {
      return await compressAsync(input, {
        dictionary,
        params: dictionaryParams(dictionary.length, input.length),
      } as Parameters<typeof zstdCompressSync>[1]);
    } catch (error) {
      warnCompressFailure(error);
      if (input.length < COMPRESS_MIN_BYTES) return input;
    }
  }

  try {
    return await compressAsync(input, { params: baseParams() });
  } catch (error) {
    warnCompressFailure(error);
    return input;
  }
}

/**
 * 按首字节识别三种存量格式：原始 zstd 帧、旧版 base64 信封、明文。
 * 解码失败时返回 null，避免把二进制垃圾当作 JSON 交给调用方。
 */
export async function decompressPayloadBinary(
  value: Buffer | string | null | undefined,
  options: BinaryPayloadOptions = {}
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;

  if (isZstdFrame(bytes)) {
    try {
      const dictionary = options.dictionary ?? null;
      const decoded =
        dictionary && dictionary.length > 0
          ? await decompressAsync(bytes, { dictionary } as Parameters<typeof zstdDecompressSync>[1])
          : await decompressAsync(bytes);
      return decoded.toString("utf8");
    } catch (error) {
      warnDecompressFailure(error);
      return null;
    }
  }

  if (
    bytes.length >= PAYLOAD_ENVELOPE_PREFIX_BYTES.length &&
    bytes.subarray(0, PAYLOAD_ENVELOPE_PREFIX_BYTES.length).equals(PAYLOAD_ENVELOPE_PREFIX_BYTES)
  ) {
    const text = bytes.toString("utf8");
    const decoded = await decompressPayload(text);
    return decoded === text ? null : decoded;
  }

  return bytes.toString("utf8");
}

function warnCompressFailure(error: unknown): void {
  if (compressFailureLogged) return;
  compressFailureLogged = true;
  logger.warn("[Compression] Payload compression failed, storing raw", {
    error: describeError(error),
  });
}

function warnDecompressFailure(error: unknown): void {
  if (decompressFailureLogged) return;
  decompressFailureLogged = true;
  logger.warn("[Compression] Payload decompression failed", {
    error: describeError(error),
  });
}

/** 仅供测试复位一次性告警标记与缓存。 */
export function resetPayloadCodecWarnings(): void {
  compressFailureLogged = false;
  decompressFailureLogged = false;
  cachedLevel = null;
  dictionarySupport = null;
}
