import type { Context } from "hono";
import { isClientAllowed } from "@/app/v1/_lib/proxy/client-detector";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";

/**
 * Which client-restricted providers a model listing may use.
 *
 * The router drops providers whose `allowedClients` / `blockedClients` reject the calling client
 * (`client_restriction`). Listings must apply the same rule, or they advertise models that client
 * can never use (a Codex catalog listing models only a `gemini-cli` allowlisted provider serves).
 * `key` names the outcome so caches are shared by every client with the same result.
 */
export interface ListingClientScope {
  blockedProviderIds: ReadonlySet<number>;
  key: string;
}

/** Subject for `isClientAllowed`: the fields the client detector reads from a proxy session. */
type ClientSubject = Pick<ProxySession, "headers" | "userAgent"> & {
  request: { message: Record<string, unknown> };
  getEndpoint: () => string | null;
  isCountTokensRequest: () => boolean;
};

/**
 * Build a detector subject from a listing request. Listings carry no message body, so Claude Code
 * keywords are confirmed from its headers alone, as the router does for count_tokens.
 */
export function listingClientSubject(headers: Headers, pathname: string): ProxySession {
  const subject: ClientSubject = {
    headers,
    userAgent: headers.get("user-agent") || null,
    request: { message: {} },
    getEndpoint: () => pathname,
    isCountTokensRequest: () => true,
  };
  return subject as unknown as ProxySession;
}

function hasClientRestriction(provider: Provider): boolean {
  return (provider.allowedClients?.length ?? 0) > 0 || (provider.blockedClients?.length ?? 0) > 0;
}

export function resolveClientScope(
  subject: ProxySession,
  providers: readonly Provider[]
): ListingClientScope {
  const blocked = new Set<number>();
  const allowed: number[] = [];
  for (const provider of providers) {
    if (!hasClientRestriction(provider)) continue;
    if (isClientAllowed(subject, provider.allowedClients ?? [], provider.blockedClients ?? [])) {
      allowed.push(provider.id);
    } else {
      blocked.add(provider.id);
    }
  }
  allowed.sort((a, b) => a - b);
  const blockedIds = [...blocked].sort((a, b) => a - b);
  return { blockedProviderIds: blocked, key: `a${allowed.join(".")}b${blockedIds.join(".")}` };
}

let lastProviders: readonly Provider[] | null = null;

/**
 * Client scope for a session (proxy requests and listings share the result for equal clients).
 * When the provider read fails, the last good provider list is used so cached catalogs can still
 * be served (a listing must not turn a transient DB error into a different answer).
 */
export async function clientScopeForSession(subject: ProxySession): Promise<ListingClientScope> {
  let providers: readonly Provider[];
  try {
    providers = await findAllProviders();
    lastProviders = providers;
  } catch (error) {
    if (!lastProviders) throw error;
    providers = lastProviders;
  }
  return resolveClientScope(subject, providers);
}

export function resetClientScopeForTests(): void {
  lastProviders = null;
}

/** Client scope for a Hono listing request. */
export function clientScopeForRequest(c: Context): Promise<ListingClientScope> {
  let headers: Headers;
  if (c.req.raw?.headers instanceof Headers) {
    headers = c.req.raw.headers;
  } else {
    try {
      headers = new Headers((c.req.header() as Record<string, string> | undefined) ?? {});
    } catch {
      headers = new Headers();
    }
  }
  return clientScopeForSession(listingClientSubject(headers, c.req.path));
}
