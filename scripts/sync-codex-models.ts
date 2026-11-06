/**
 * Refresh the bundled Codex built-in model templates used by the /codex/models catalog.
 *
 * Usage:
 *   bun run codex-models:sync --commit <sha>          # download from GitHub at that commit
 *   bun run codex-models:sync --from <path> --commit <sha>
 *   bun run codex-models:sync --check                 # verify the bundled copies still parse
 *   bun run codex-models:sync --deepseek [--from <setup.sh path>]
 *                                                     # refresh DeepSeek's Codex entries
 *
 * Files are copied byte for byte and validated with the same schema the gateway uses.
 * DeepSeek's entries are the `CODEX_MODELS_JSON` heredoc of its official setup script, which the
 * script writes verbatim to ~/.codex/models.json. The script is only read, never executed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexCatalogResponseSchema, describeCodexCatalogIssue } from "@/lib/codex-catalog/schema";

const REPO_URL = "https://github.com/openai/codex";
const SOURCE_PATH = "codex-rs/models-manager/models.json";
const dataDir = path.join(process.cwd(), "src/lib/codex-catalog/data");
const outputPath = path.join(dataDir, "codex-builtin-models.json");
const sourceInfoPath = path.join(dataDir, "SOURCE");
const deepseekPath = path.join(dataDir, "deepseek-models.json");
const deepseekSourcePath = path.join(dataDir, "deepseek-models.SOURCE");
const DEEPSEEK_SETUP_URL = "https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh";
const DEEPSEEK_DOCS_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/";

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

/** Extract the quoted `CODEX_MODELS_JSON` heredoc body from DeepSeek's setup script. */
export function extractDeepseekModels(script: string): string | null {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => /<<\s*'CODEX_MODELS_JSON'\s*$/.test(line));
  if (start < 0) return null;
  const end = lines.indexOf("CODEX_MODELS_JSON", start + 1);
  if (end < 0) return null;
  return `${lines.slice(start + 1, end).join("\n")}\n`;
}

if (process.argv.includes("--check")) {
  const count = validate(readFileSync(outputPath, "utf8"), outputPath);
  const vendor = validate(readFileSync(deepseekPath, "utf8"), deepseekPath);
  console.log(`OK: ${count} bundled Codex templates, ${vendor} DeepSeek templates`);
  process.exit(0);
}

if (process.argv.includes("--deepseek")) {
  const from = argValue("--from");
  let script: string;
  if (from) {
    script = readFileSync(from, "utf8");
  } else {
    const response = await fetch(DEEPSEEK_SETUP_URL);
    if (!response.ok) {
      console.error(`Download failed: ${response.status} ${DEEPSEEK_SETUP_URL}`);
      process.exit(1);
    }
    script = await response.text();
  }
  const text = extractDeepseekModels(script);
  if (!text) {
    console.error("CODEX_MODELS_JSON heredoc not found in the DeepSeek setup script");
    process.exit(1);
  }
  const count = validate(text, "DeepSeek setup script");
  writeFileSync(deepseekPath, text);
  writeFileSync(
    deepseekSourcePath,
    `${DEEPSEEK_SETUP_URL}\nheredoc CODEX_MODELS_JSON (written verbatim to ~/.codex/models.json by the script)\ndocs: ${DEEPSEEK_DOCS_URL}\nfetched ${new Date().toISOString().slice(0, 10)}\n`
  );
  console.log(`Wrote ${count} DeepSeek templates`);
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
