import type { Context } from "hono";
import { isClientAllowed } from "@/app/v1/_lib/proxy/client-detector";
import { checkProviderGroupMatch } from "@/app/v1/_lib/proxy/provider-selector";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { resolveRoutingProviderGroup } from "@/lib/utils/provider-group";
import { findAllProviders } from "@/repository/provider";
import type { Provider } from "@/types/provider";
import {
  findUnhealthyProviderIds,
  isListingClientRejected,
  type ListingPreflightUser,
} from "./listing-preflight";

/**
 * Which providers a model listing may use for the calling client, from a preflight of the
 * request-path checks that do not depend on the request body.
 *
 * - `denied`: the user-level client gate or the version gate rejects the client, so every model
 *   request would fail and listings are empty.
 * - `blockedProviderIds`: providers the router would drop for this client: `allowedClients` /
 *   `blockedClients` (`client_restriction`), open circuits, spend limits, low upstream quota.
 *   Without this a Codex catalog lists models only a `gemini-cli` allowlisted, or currently
 *   circuit-broken, provider serves.
 *
 * `key` names the outcome so caches are shared by every client with the same result.
 */
export interface ListingClientScope {
  blockedProviderIds: ReadonlySet<number>;
  denied?: boolean;
  key: string;
}

/** Caller identity a listing preflight needs (a subset of the proxy auth state). */
export interface ListingAuth {
  user: ListingPreflightUser;
  key: { providerGroup: string | null };
}

const DENIED_SCOPE: ListingClientScope = {
  blockedProviderIds: new Set(),
  denied: true,
  key: "denied",
};

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
 * Listing scope for a session (proxy requests and listings share the result for equal clients).
 * When the provider read fails, the last good provider list is used so cached catalogs can still
 * be served (a listing must not turn a transient DB error into a different answer).
 */
export async function clientScopeForSession(
  subject: ProxySession,
  auth: ListingAuth
): Promise<ListingClientScope> {
  let providers: readonly Provider[];
  try {
    providers = await findAllProviders();
    lastProviders = providers;
  } catch (error) {
    if (!lastProviders) throw error;
    providers = lastProviders;
  }

  if (await isListingClientRejected(subject, auth.user)) return DENIED_SCOPE;

  const clientScope = resolveClientScope(subject, providers);
  const group = resolveRoutingProviderGroup(auth.key.providerGroup);
  const candidates = providers.filter(
    (p) =>
      p.isEnabled &&
      !clientScope.blockedProviderIds.has(p.id) &&
      checkProviderGroupMatch(p.groupTag, group)
  );
  const unhealthy = await findUnhealthyProviderIds(candidates);
  if (unhealthy.size === 0) return clientScope;

  const blocked = new Set([...clientScope.blockedProviderIds, ...unhealthy]);
  const unhealthyIds = [...unhealthy].sort((a, b) => a - b);
  return { blockedProviderIds: blocked, key: `${clientScope.key}h${unhealthyIds.join(".")}` };
}

export function resetClientScopeForTests(): void {
  lastProviders = null;
}

/** Listing scope for a Hono listing request. */
export function clientScopeForRequest(c: Context, auth: ListingAuth): Promise<ListingClientScope> {
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
  return clientScopeForSession(listingClientSubject(headers, c.req.path), auth);
}
