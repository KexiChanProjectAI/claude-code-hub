/**
 * Markdown rendering of the model catalog for LLM agents.
 *
 * Intentionally English-only and not localized: the output is consumed by models and scripts,
 * and stable wording keeps it diffable. The human page uses next-intl instead.
 */
import { CATALOG_PROTOCOLS } from "./protocols";
import type { CatalogModel, ModelCatalog } from "./types";

export const CATALOG_ENDPOINT_PATH = "/v1/models/catalog";

const NA = "n/a";

function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || NA;
}

function formatTokens(value: number | null): string {
  if (value === null) return NA;
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  return `$${Number(value.toFixed(4))}`;
}

function capabilityList(model: CatalogModel): string {
  if (!model.capabilities) return NA;
  const flags: string[] = [];
  if (model.capabilities.vision) flags.push("vision");
  if (model.capabilities.functionCalling) flags.push("tools");
  if (model.capabilities.reasoning) flags.push("reasoning");
  if (model.capabilities.pdfInput) flags.push("pdf");
  if (model.capabilities.promptCaching) flags.push("prompt-caching");
  return flags.length > 0 ? flags.join(", ") : "none";
}

function modalityList(model: CatalogModel): string {
  if (!model.modalities) return NA;
  const input = model.modalities.input.join("+") || NA;
  const output = model.modalities.output.join("+") || NA;
  return `${input} -> ${output}`;
}

export function renderCatalogMarkdown(
  catalog: ModelCatalog,
  opts: { baseUrl: string | null }
): string {
  const lines: string[] = [];
  const base = opts.baseUrl?.replace(/\/$/, "") ?? null;
  const labelById = new Map(CATALOG_PROTOCOLS.map((protocol) => [protocol.id, protocol.label]));

  lines.push("# Model Catalog", "");
  lines.push(`Generated at: ${catalog.generatedAt}`);
  lines.push("Scope: the models usable by the API key that requested this document.");
  lines.push(
    base
      ? `Base URL: ${base} (append the endpoint paths below).`
      : "Base URL: the origin this document was fetched from."
  );
  lines.push(
    "Authentication: send the same API key as `Authorization: Bearer <key>` or `x-api-key: <key>` (Gemini protocols also accept `x-goog-api-key`)."
  );
  lines.push(
    "Prices: USD per 1M tokens, base tier only (long-context and priority tiers are not shown)."
  );
  lines.push(
    "A model can only be called through the protocols listed for it; the proxy does not translate between protocols."
  );
  lines.push("");

  lines.push("## Protocols", "");
  lines.push("| Protocol | Name | Endpoint | Models |", "|---|---|---|---|");
  for (const protocol of catalog.protocols) {
    lines.push(
      `| ${cell(protocol.id)} | ${cell(protocol.label)} | \`${protocol.endpointPath}\` | ${protocol.models.length} |`
    );
  }
  lines.push("");

  lines.push("## Models", "");
  if (catalog.models.length === 0) {
    lines.push("No models are available to this key.", "");
  } else {
    lines.push(
      "| Model | Vendor | Protocols | Context | Max output | Input | Output | Cache read | Cache write | Capabilities | Modalities | Knowledge cutoff | Deprecated |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    );
    for (const model of catalog.models) {
      const name =
        model.displayName && model.displayName !== model.id
          ? `\`${cell(model.id)}\` (${cell(model.displayName)})`
          : `\`${cell(model.id)}\``;
      lines.push(
        [
          "",
          name,
          cell(model.vendorName ?? model.vendor ?? NA),
          cell(model.protocols.join(", ")),
          formatTokens(model.contextWindow),
          formatTokens(model.maxOutputTokens),
          formatPrice(model.pricing?.input),
          formatPrice(model.pricing?.output),
          formatPrice(model.pricing?.cacheRead),
          formatPrice(model.pricing?.cacheWrite),
          cell(capabilityList(model)),
          cell(modalityList(model)),
          cell(model.knowledgeCutoff ?? NA),
          model.deprecated ? "yes" : "no",
          "",
        ]
          .join(" | ")
          .trim()
      );
    }
    lines.push("");
  }

  const populated = catalog.protocols.filter((protocol) => protocol.models.length > 0);
  if (populated.length > 0) {
    lines.push("## Models by protocol", "");
    for (const protocol of populated) {
      lines.push(
        `### ${protocol.id}: ${labelById.get(protocol.id) ?? protocol.label} (\`${protocol.endpointPath}\`)`,
        ""
      );
      for (const id of protocol.models) {
        lines.push(`- \`${id}\``);
      }
      lines.push("");
    }
  }

  lines.push("## Machine-readable", "");
  lines.push(`- JSON: \`GET ${base ?? ""}${CATALOG_ENDPOINT_PATH}\``);
  lines.push(`- Markdown: \`GET ${base ?? ""}${CATALOG_ENDPOINT_PATH}?format=md\``);
  lines.push("");

  if (catalog.notes) {
    lines.push("## Notes from the administrator", "", catalog.notes, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
