import type { Context } from "hono";
import { defaultLocale, locales } from "@/i18n/config";
import { buildModelCatalog, renderCatalogMarkdown } from "@/lib/model-catalog";
import { authenticateApiKeyRequest } from "../models/authenticate-request";

export type CatalogResponseFormat = "json" | "markdown" | "html";

/**
 * Pick the response representation.
 *
 * `?format=` wins. Otherwise browsers (Accept includes text/html) are sent to the human page,
 * `text/markdown` / `text/plain` get Markdown, and everything else (curl, SDKs, `*\/*`) gets JSON.
 */
export function negotiateCatalogFormat(input: {
  formatQuery?: string | null;
  accept?: string | null;
}): CatalogResponseFormat {
  const format = input.formatQuery?.trim().toLowerCase();
  if (format === "json") return "json";
  if (format === "md" || format === "markdown" || format === "text") return "markdown";
  if (format === "html") return "html";

  const accept = input.accept?.toLowerCase() ?? "";
  if (accept.includes("text/html")) return "html";
  if (accept.includes("text/markdown") || accept.includes("text/plain")) return "markdown";
  return "json";
}

function firstHeaderValue(value: string | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

/** Origin as seen by the client, honoring a reverse proxy's forwarded headers. */
export function resolvePublicBaseUrl(c: Context): string | null {
  try {
    const url = new URL(c.req.url);
    const proto = firstHeaderValue(c.req.header("x-forwarded-proto"));
    const host = firstHeaderValue(c.req.header("x-forwarded-host"));
    const protocol = proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "");
    return `${protocol}://${host ?? url.host}`;
  } catch {
    return null;
  }
}

async function resolveLocale(): Promise<string> {
  try {
    const { getLocale } = await import("next-intl/server");
    const locale = await getLocale();
    if ((locales as readonly string[]).includes(locale)) return locale;
  } catch {
    // Outside a Next.js request scope: fall through to the default locale.
  }
  return defaultLocale;
}

function applyCommonHeaders(c: Context): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Accept");
}

/**
 * GET /v1/models/catalog (also /models/catalog)
 *
 * Catalog of the models the calling API key can use, with protocols, limits, prices and
 * capabilities, plus the admin's agent notes. JSON by default, Markdown for LLMs.
 */
export async function handleModelCatalog(c: Context): Promise<Response> {
  const format = negotiateCatalogFormat({
    formatQuery: c.req.query("format"),
    accept: c.req.header("accept"),
  });

  applyCommonHeaders(c);

  // Browsers usually carry no API key; send them to the cookie-authenticated page before auth.
  if (format === "html") {
    const locale = await resolveLocale();
    return c.redirect(`/${locale}/models`, 302);
  }

  try {
    const { user, key } = await authenticateApiKeyRequest(c);
    const catalog = await buildModelCatalog({ user, key });

    if (format === "markdown") {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      return c.body(renderCatalogMarkdown(catalog, { baseUrl: resolvePublicBaseUrl(c) }), 200);
    }

    return c.json(catalog);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
