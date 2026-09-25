import type { Agent as HttpAgent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export function createNodeProxyAgent(proxyUrl: string): HttpAgent {
  const protocol = new URL(proxyUrl).protocol;
  if (protocol === "http:" || protocol === "https:") {
    return new HttpsProxyAgent(proxyUrl);
  }
  if (protocol === "socks4:" || protocol === "socks5:") {
    return new SocksProxyAgent(proxyUrl);
  }
  throw new Error(
    `Unsupported proxy protocol: ${protocol}. Supported protocols: http://, https://, socks5://, socks4://`
  );
}
