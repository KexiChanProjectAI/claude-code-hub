// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../scripts/cch-client-setup.sh");
const GOOD_KEY = "sk-good-0123456789abcdef";

const codexCatalog = {
  models: [
    { slug: "daily/gpt-6.1-sol", visibility: "list" },
    { slug: "gpt-6-sol", visibility: "list" },
    { slug: "deepseek-flash", visibility: "list" },
  ],
};
const discovery = (ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, metadata: { display_name: id } })),
});

let server: http.Server;
let baseUrl = "";
const requests: { path: string; auth: string | undefined; ua: string | undefined }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({
      path: req.url ?? "",
      auth: req.headers.authorization,
      ua: req.headers["user-agent"],
    });
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"type":"invalid_api_key"}}');
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const bodies: Record<string, unknown> = {
      "/codex/models": codexCatalog,
      "/anthropic/v1/models": discovery(["claude-x", "deepseek-flash"]),
      "/chat/v1/models": discovery([]),
      "/responses/v1/models": discovery(["gpt-6.1-sol"]),
    };
    const body = bodies[url.pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-setup-"));
  requests.length = 0;
});

function run(
  args: string[],
  input: string,
  env: Record<string, string | undefined> = {}
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // detached: new session without a controlling terminal, so the script reads stdin.
    const child = spawn("bash", [SCRIPT, ...args], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        CCH_HOST: baseUrl,
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", () => {});
    child.on("close", (code) => resolve({ code, stderr }));
    // The script may exit before reading stdin (e.g. missing CCH_HOST); ignore EPIPE then.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const read = (...parts: string[]) => fs.readFileSync(path.join(home, ...parts), "utf8");
const mode = (...parts: string[]) => fs.statSync(path.join(home, ...parts)).mode & 0o777;
const backups = (dir: string, base: string) =>
  fs.readdirSync(path.join(home, dir)).filter((name) => name.startsWith(`${base}.bak.`));

describe("cch-client-setup.sh", () => {
  it("requires CCH_HOST", async () => {
    const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_HOST: undefined });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("set CCH_HOST");
  });

  it("rejects an unknown client", async () => {
    const result = await run(["vim"], `${GOOD_KEY}\n`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown client");
  });

  it("writes a fresh Codex config with the catalog URL", async () => {
    const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_HOST: `${baseUrl}/v1/` });
    expect(result.code, result.stderr).toBe(0);
    const config = read(".codex", "config.toml");
    expect(config).toContain('model_provider = "cch"');
    expect(config).toContain("[model_providers.cch]");
    expect(config).toContain(`base_url = "${baseUrl}/v1"`);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain(`experimental_bearer_token = "${GOOD_KEY}"`);
    expect(config).toContain(`model_catalog_url = "${baseUrl}/codex/models"`);
    expect(config).toContain('model = "gpt-6-sol"');
    expect(mode(".codex", "config.toml")).toBe(0o600);
    expect(result.stderr).toContain("3 models");
    expect(result.stderr).toContain("Default model: gpt-6-sol");
    expect(result.stderr).not.toContain(GOOD_KEY);
    expect(requests[0]).toMatchObject({
      path: "/codex/models?client_version=0.0.0",
      ua: "codex_cli_rs/0.0.0",
    });
  });

  it("keeps unrelated Codex settings, replaces its own, and is idempotent", async () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      [
        'model = "openai/test/gpt-6.1-sol"',
        'model_provider = "zenkexi"',
        'approval_policy = "never"',
        "",
        "[model_providers.zenkexi]",
        'name = "zenkexi"',
        'base_url = "https://old.example.com/v1"',
        "",
        "[model_providers.cch]",
        'base_url = "https://stale.example.com/v1"',
        "",
        "[tui]",
        "screen_reader_detection_done = true",
        "",
      ].join("\n")
    );
    for (let i = 0; i < 2; i++) {
      const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_MODEL: "deepseek-flash" });
      expect(result.code, result.stderr).toBe(0);
    }
    const config = read(".codex", "config.toml");
    expect(config.match(/^model_provider = /gm)).toEqual(["model_provider = "]);
    expect(config).toContain('model_provider = "cch"');
    expect(config).toContain('model = "deepseek-flash"');
    expect(config).not.toContain("openai/test/gpt-6.1-sol");
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain("[model_providers.zenkexi]");
    expect(config).toContain("[tui]");
    expect(config).not.toContain("stale.example.com");
    expect(config.match(/\[model_providers\.cch\]/g)).toHaveLength(1);
    // top-level keys stay above every table
    expect(config.indexOf('model_provider = "cch"')).toBeLessThan(config.indexOf("["));
    expect(backups(".codex", "config.toml").length).toBeGreaterThanOrEqual(1);
  });

  it("leaves the model unset when the catalog has no gpt-6-sol", async () => {
    const saved = codexCatalog.models.splice(1, 1);
    try {
      const result = await run(["codex"], `${GOOD_KEY}\n`);
      expect(result.code, result.stderr).toBe(0);
      expect(read(".codex", "config.toml")).not.toMatch(/^model = /m);
      expect(result.stderr).toContain("gpt-6-sol is not in the gateway catalog");
    } finally {
      codexCatalog.models.splice(1, 0, ...saved);
    }
  });

  it("keeps an explicit CCH_MODEL even when the catalog does not list it", async () => {
    const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_MODEL: "my-model" });
    expect(result.code, result.stderr).toBe(0);
    expect(read(".codex", "config.toml")).toContain('model = "my-model"');
    expect(result.stderr).toContain("CCH_MODEL=my-model is not in the gateway catalog");
  });

  it("retries a rejected key and then succeeds", async () => {
    const result = await run(["codex"], `sk-bad\nsk-also-bad\n${GOOD_KEY}\n`);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.match(/rejected this key/g)).toHaveLength(2);
  });

  it("gives up after three rejected keys without writing anything", async () => {
    const result = await run(["codex"], "a\nb\nc\n");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no valid API key");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("refuses keys with quotes or spaces", async () => {
    const result = await run(["codex"], `sk "x\n${GOOD_KEY}\n`);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("spaces, quotes or backslashes");
  });

  it("writes omp providers only for protocols that have models", async () => {
    const result = await run(["omp"], `${GOOD_KEY}\n`);
    expect(result.code, result.stderr).toBe(0);
    const yml = read(".omp", "agent", "models.yml");
    expect(yml.startsWith("providers:\n")).toBe(true);
    expect(yml).toContain("  cch-anthropic:\n");
    expect(yml).toContain(`    baseUrl: ${baseUrl}/anthropic/v1\n`);
    expect(yml).toContain("    api: anthropic-messages\n    auth: apiKey\n");
    expect(yml).toContain("  cch-responses:\n");
    expect(yml).toContain(`    baseUrl: ${baseUrl}/responses/v1\n`);
    expect(yml).toContain("    api: openai-responses\n");
    expect(yml).toContain(`    apiKey: "${GOOD_KEY}"\n`);
    expect(yml).toContain("    discovery: { type: openai-models-list }\n");
    expect(yml).not.toContain("cch-chat");
    expect(result.stderr).toContain("skip cch-chat: no models");
    expect(mode(".omp", "agent", "models.yml")).toBe(0o600);
  });

  it("merges into an existing omp providers map and is idempotent", async () => {
    fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".omp", "agent", "models.yml"),
      "providers:\n  mine:\n    baseUrl: https://mine.example.com/v1\n    api: openai-completions\n"
    );
    for (let i = 0; i < 2; i++) {
      const result = await run(["omp"], `${GOOD_KEY}\n`, { PI_CODING_AGENT_DIR: undefined });
      expect(result.code, result.stderr).toBe(0);
    }
    const yml = read(".omp", "agent", "models.yml");
    expect(yml.match(/^providers:/gm)).toHaveLength(1);
    expect(yml.match(/ {2}cch-responses:/g)).toHaveLength(1);
    expect(yml).toContain("  mine:\n    baseUrl: https://mine.example.com/v1\n");
    expect(backups(path.join(".omp", "agent"), "models.yml").length).toBeGreaterThanOrEqual(1);
  });

  it("appends a providers map to an omp file without one, and refuses inline maps", async () => {
    fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    const file = path.join(home, ".omp", "agent", "models.yml");
    fs.writeFileSync(file, "# settings\n");
    expect((await run(["omp"], `${GOOD_KEY}\n`)).code).toBe(0);
    expect(read(".omp", "agent", "models.yml")).toMatch(/^# settings\n\nproviders:\n/);

    fs.writeFileSync(file, "providers: {}\n");
    const inline = await run(["omp"], `${GOOD_KEY}\n`);
    expect(inline.code).not.toBe(0);
    expect(inline.stderr).toContain("inline providers map");
    expect(read(".omp", "agent", "models.yml")).toBe("providers: {}\n");
  });

  it("configures both clients with a custom provider name and directories", async () => {
    const codexHome = path.join(home, "codex-alt");
    const ompDir = path.join(home, "omp-alt");
    const result = await run(["both"], `${GOOD_KEY}\n`, {
      CCH_PROVIDER_NAME: "hub",
      CODEX_HOME: codexHome,
      PI_CODING_AGENT_DIR: ompDir,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
      "[model_providers.hub]"
    );
    expect(fs.readFileSync(path.join(ompDir, "models.yml"), "utf8")).toContain("  hub-responses:");
  });

  it("discovers as the target client, with versions from installed clients", async () => {
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.166.0'\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(bin, "omp"),
      '#!/bin/sh\n[ "$1" = "--version" ] && echo omp/18.17.0\nexit 0\n',
      { mode: 0o755 }
    );
    const result = await run(["both"], `${GOOD_KEY}\n`, { PATH: `${bin}:/usr/bin:/bin` });
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      path: "/codex/models?client_version=0.166.0",
      ua: "codex_cli_rs/0.166.0",
    });
    const discovery = requests.filter((r) => r.path.endsWith("/v1/models"));
    expect(discovery.map((r) => r.ua)).toEqual(["omp/18.17.0", "omp/18.17.0", "omp/18.17.0"]);
    expect(result.stderr).toContain("omp models refreshed");
  });

  describe("Codex daemon refresh", () => {
    function fakeCodex(running: boolean) {
      const bin = path.join(home, "fakebin");
      fs.mkdirSync(bin, { recursive: true });
      const log = path.join(home, "codex-calls.log");
      fs.writeFileSync(
        path.join(bin, "codex"),
        [
          "#!/bin/sh",
          `echo "CODEX_HOME=$CODEX_HOME $*" >> ${log}`,
          'case "$*" in',
          "  --version) echo 'codex-cli 0.167.0' ;;",
          `  "app-server daemon version") ${running ? `echo '{"status":"running","backend":"pid"}'` : "echo 'Error: failed to connect' >&2; exit 1"} ;;`,
          `  "app-server daemon restart") echo '{"status":"restarted"}' ;;`,
          '  "debug models") echo \'{"models":[]}\' ;;',
          "esac",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      return {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
      };
    }

    it("warms the catalog and restarts a running daemon by default", async () => {
      const codex = fakeCodex(true);
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      const calls = codex.calls();
      expect(calls).toContain(`CODEX_HOME=${path.join(home, ".codex")} debug models`);
      expect(calls).toContain("app-server daemon restart");
      expect(calls.indexOf("debug models")).toBeLessThan(calls.indexOf("daemon restart"));
      expect(result.stderr).toContain("Restarted the Codex app-server daemon");
    });

    it("only prints the restart command when CCH_RESTART_CODEX_DAEMON=0", async () => {
      const codex = fakeCodex(true);
      const result = await run(["codex"], `${GOOD_KEY}\n`, {
        ...codex.env,
        CCH_RESTART_CODEX_DAEMON: "0",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(codex.calls()).not.toContain("daemon restart");
      expect(result.stderr).toContain("codex app-server daemon restart");
    });

    it("does not touch a daemon that is not running", async () => {
      const codex = fakeCodex(false);
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      expect(codex.calls()).toContain("app-server daemon version");
      expect(codex.calls()).not.toContain("daemon restart");
      expect(result.stderr).not.toContain("daemon");
    });

    it("skips everything when codex is not installed", async () => {
      const result = await run(["codex"], `${GOOD_KEY}\n`);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("daemon");
      expect(result.stderr).not.toContain("catalog fetched");
    });
  });

  it("reports an unreachable gateway", async () => {
    const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_HOST: "http://127.0.0.1:1" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot reach");
  });
});
