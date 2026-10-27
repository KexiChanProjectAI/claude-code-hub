import type Redis from "ioredis";

type BufferEvalClient = Pick<Redis, "callBuffer">;

/**
 * 以 Buffer 形式返回 EVAL 的 bulk reply。ioredis 没有 evalBuffer，
 * 默认的 eval 会把二进制正文按 UTF-8 解码而损坏 zstd 帧，因此改走 callBuffer。
 * 整数 reply 仍为 number，数组 reply 中的 bulk 元素为 Buffer，nil 为 null。
 */
export async function evalBuffer(
  redis: BufferEvalClient,
  script: string,
  numKeys: number,
  ...args: Array<string | number | Buffer>
): Promise<unknown> {
  return redis.callBuffer("EVAL", [script, numKeys, ...args]);
}

/** 把 evalBuffer 结果中的单个元素规范为 Buffer；nil/false 返回 null。 */
export function toReplyBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}
