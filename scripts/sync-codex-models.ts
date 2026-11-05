/**
 * Refresh the bundled Codex built-in model templates used by the /codex/models catalog.
 *
 * Usage:
 *   bun run codex-models:sync --commit <sha>          # download from GitHub at that commit
 *   bun run codex-models:sync --from <path> --commit <sha>
 *   bun run codex-models:sync --check                 # verify the bundled copy still parses
 *
 * The file is copied byte for byte and validated with the same schema the gateway uses.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexCatalogResponseSchema, describeCodexCatalogIssue } from "@/lib/codex-catalog/schema";

const REPO_URL = "https://github.com/openai/codex";
const SOURCE_PATH = "codex-rs/models-manager/models.json";
const dataDir = path.join(process.cwd(), "src/lib/codex-catalog/data");
const outputPath = path.join(dataDir, "codex-builtin-models.json");
const sourceInfoPath = path.join(dataDir, "SOURCE");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validate(text: string, origin: string): number {
  const parsed = CodexCatalogResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    console.error(`${origin} is not a valid Codex catalog: ${describeCodexCatalogIssue(parsed.error)}`);
    process.exit(1);
  }
  const slugs = parsed.data.models.map((model) => model.slug);
  if (new Set(slugs).size !== slugs.length) {
    console.error(`${origin} contains duplicate slugs`);
    process.exit(1);
  }
  return slugs.length;
}

if (process.argv.includes("--check")) {
  const count = validate(readFileSync(outputPath, "utf8"), outputPath);
  console.log(`OK: ${count} bundled Codex templates`);
  process.exit(0);
}

const commit = argValue("--commit");
const from = argValue("--from");
if (!commit) {
  console.error("Missing --commit <sha> (recorded in data/SOURCE for provenance)");
  process.exit(1);
}

let text: string;
if (from && existsSync(from)) {
  text = readFileSync(from, "utf8");
} else {
  const url = from ?? `https://raw.githubusercontent.com/openai/codex/${commit}/${SOURCE_PATH}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Download failed: ${response.status} ${url}`);
    process.exit(1);
  }
  text = await response.text();
}

const count = validate(text, from ?? "download");
writeFileSync(outputPath, text);
writeFileSync(sourceInfoPath, `${REPO_URL}\n${commit}\n${SOURCE_PATH}\n`);
console.log(`Wrote ${count} Codex templates from ${commit}`);
