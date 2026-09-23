import {
  PROXY_PATH_ROOTS,
  parseListenPrefixes,
  RESERVED_FIRST_SEGMENTS,
  stripListenPrefix,
} from "../../server-lib/listen-prefix";

export { PROXY_PATH_ROOTS, parseListenPrefixes, RESERVED_FIRST_SEGMENTS, stripListenPrefix };

export const PROXY_LISTEN_PREFIX_ENV = "PROXY_LISTEN_PREFIX";

let cachedRaw: string | undefined;
let cachedPrefixes: readonly string[] = [];
let hasCached = false;

/**
 * 读取并缓存 PROXY_LISTEN_PREFIX。
 *
 * 直接读 process.env 而非 getEnvConfig()，避免把完整的 Zod 解析拉进
 * Next middleware（src/proxy.ts）bundle；env.schema.ts 仍会在启动时用同一个
 * 解析器校验该变量，保证配置错误快速失败。
 */
export function getProxyListenPrefixes(): readonly string[] {
  const raw = process.env[PROXY_LISTEN_PREFIX_ENV];
  if (hasCached && raw === cachedRaw) {
    return cachedPrefixes;
  }

  const { prefixes, error } = parseListenPrefixes(raw);
  if (error) {
    throw new Error(`${PROXY_LISTEN_PREFIX_ENV} ${error}`);
  }

  cachedRaw = raw;
  cachedPrefixes = Object.freeze(prefixes);
  hasCached = true;
  return cachedPrefixes;
}

/**
 * 把带自定义前缀的路径映射回规范代理路径；非代理路径返回 null。
 */
export function resolveListenPrefixedPath(pathname: string): string | null {
  const prefixes = getProxyListenPrefixes();
  if (prefixes.length === 0) return null;
  return stripListenPrefix(pathname, prefixes);
}

export function resetProxyListenPrefixCacheForTests(): void {
  cachedRaw = undefined;
  cachedPrefixes = [];
  hasCached = false;
}
