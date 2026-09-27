import type { FailResponse, HeaderPairs } from "./contract";

/**
 * 把本地路径构造的客户端错误响应（守卫早退 / ProxyErrorHandler.handle 的结果）序列化为
 * FailResponse。正文以原始字节文本透传，远端原样写回，保证与本地返回逐字节一致。
 */
export async function responseToFailPayload(response: Response): Promise<FailResponse> {
  const headers: HeaderPairs = [];
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // 传输层头由远端按实际写出的正文重算
    if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection") {
      return;
    }
    headers.push([lower, value]);
  });
  return {
    status: response.status,
    headers,
    bodyText: await response.text(),
  };
}
