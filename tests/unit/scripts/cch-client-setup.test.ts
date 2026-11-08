// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  env: Record<string, string | undefined> = {},
  cwd?: string
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // detached: new session without a controlling terminal, so the script reads stdin.
    const child = spawn("bash", [SCRIPT, ...args], {
      detached: true,
      cwd,
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
    expect(config).not.toContain("experimental_bearer_token");
    expect(config).not.toContain(GOOD_KEY);
    const keyFile = path.join(home, ".codex", "cch.key");
    expect(config).toContain(
      `[model_providers.cch.auth]\ncommand = "cat"\nargs = ["${keyFile}"]\nrefresh_interval_ms = 0\ncwd = "${path.join(home, ".codex")}"\n`
    );
    expect(fs.readFileSync(keyFile, "utf8")).toBe(`${GOOD_KEY}\n`);
    expect(mode(".codex", "cch.key")).toBe(0o600);
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
        'experimental_bearer_token = "sk-stale"',
        "",
        "[model_providers.cch.auth]",
        'command = "stale-command"',
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
    expect(config.match(/\[model_providers\.cch\.auth\]/g)).toHaveLength(1);
    expect(config).not.toContain("stale-command");
    expect(config).not.toContain("sk-stale");
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

  describe("custom Codex home and omp dir", () => {
    it("expands a literal ~ and tells how to point Codex at the home", async () => {
      const result = await run(["both"], `${GOOD_KEY}\n`, {
        CODEX_HOME: "~/work/codex-home/",
        PI_CODING_AGENT_DIR: "~/work/omp",
      });
      expect(result.code, result.stderr).toBe(0);
      const dir = path.join(home, "work", "codex-home");
      const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      expect(config).toContain(`args = ["${path.join(dir, "cch.key")}"]`);
      expect(config).toContain(`cwd = "${dir}"`);
      expect(fs.readFileSync(path.join(dir, "cch.key"), "utf8").trim()).toBe(GOOD_KEY);
      expect(fs.existsSync(path.join(home, "~"))).toBe(false);
      expect(result.stderr).toContain(`export CODEX_HOME="${dir}"`);
      expect(fs.readFileSync(path.join(home, "work", "omp", "models.yml"), "utf8")).toContain(
        "  cch-responses:"
      );
      expect(result.stderr).toContain(
        `export PI_CODING_AGENT_DIR="${path.join(home, "work", "omp")}"`
      );
    });

    it("resolves a relative CODEX_HOME from the current directory", async () => {
      fs.mkdirSync(path.join(home, "proj"));
      const result = await run(
        ["codex"],
        `${GOOD_KEY}\n`,
        { CODEX_HOME: "rel/codex" },
        path.join(home, "proj")
      );
      expect(result.code, result.stderr).toBe(0);
      const dir = path.join(home, "proj", "rel", "codex");
      expect(fs.readFileSync(path.join(dir, "config.toml"), "utf8")).toContain(`cwd = "${dir}"`);
      expect(result.stderr).toContain(`export CODEX_HOME="${dir}"`);
    });

    it("prints no export hint for the default locations", async () => {
      const result = await run(["both"], `${GOOD_KEY}\n`, {
        CODEX_HOME: path.join(home, ".codex"),
        PI_CODING_AGENT_DIR: "",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("export CODEX_HOME");
      expect(result.stderr).not.toContain("export PI_CODING_AGENT_DIR");
      expect(read(".omp", "agent", "models.yml")).toContain("  cch-responses:");
    });

    it("reuses a key from the config in a ~ Codex home", async () => {
      const dir = path.join(home, "alt-codex");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "config.toml"),
        `[model_providers.crs]\nbase_url = "https://crs.jackllm4sci.online/v1"\nexperimental_bearer_token = "${GOOD_KEY}"\n`
      );
      const result = await run(["codex"], "", { CODEX_HOME: "~/alt-codex" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        `Found a working key in Codex ${path.join(dir, "config.toml")}`
      );
      expect(fs.readFileSync(path.join(dir, "cch.key"), "utf8").trim()).toBe(GOOD_KEY);
    });
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
    const spawned: number[] = [];
    afterEach(() => {
      for (const pid of spawned.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    async function waitGone(pid: number) {
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      return !alive(pid);
    }

    /** A process that looks like Codex's managed daemon: `<bin> app-server ... --managed-daemon`. */
    function startFakeDaemon(binDir: string, pidFile?: string) {
      fs.mkdirSync(binDir, { recursive: true });
      const bin = path.join(binDir, "codex");
      fs.writeFileSync(bin, "trap 'exit 0' TERM\nwhile :; do sleep 1; done\n", { mode: 0o755 });
      const child = spawn(
        "sh",
        [
          bin,
          "app-server",
          "--listen",
          "unix://",
          "--analytics-default-enabled",
          "--managed-daemon",
        ],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      const pid = child.pid as number;
      spawned.push(pid);
      if (pidFile) {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, JSON.stringify({ pid, processStartTime: "x" }));
      }
      return pid;
    }

    const codexHome = () => path.join(home, ".codex");
    const daemonBin = () =>
      path.join(codexHome(), "packages", "app-server-daemon", "releases", "0.167.0-x", "bin");
    const pidFile = () => path.join(codexHome(), "app-server-daemon", "daemon.pid");

    /**
     * Fake `codex` CLI. version: running | stopped | hang; stop: works (kills the pid-file
     * process) | broken (fails and leaves the daemon running).
     */
    function fakeCodex(opts: {
      version: "running" | "stopped" | "hang";
      stop?: "works" | "broken";
    }) {
      const bin = path.join(home, "fakebin");
      fs.mkdirSync(bin, { recursive: true });
      const log = path.join(home, "codex-calls.log");
      const version = {
        running: `echo '{"status":"running","backend":"pid"}'`,
        stopped: "echo 'Error: failed to connect' >&2; exit 1",
        hang: "exit 1",
      }[opts.version];
      const stop =
        opts.stop === "works"
          ? `p=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$CODEX_HOME/app-server-daemon/daemon.pid"); kill $p; rm -f "$CODEX_HOME/app-server-daemon/daemon.pid"; echo '{"status":"stopped"}'`
          : "echo 'Error: timed out waiting for the daemon' >&2; exit 1";
      fs.writeFileSync(
        path.join(bin, "codex"),
        [
          "#!/bin/sh",
          `echo "CODEX_HOME=$CODEX_HOME cwd=$PWD $*" >> ${log}`,
          'case "$*" in',
          "  --version) echo 'codex-cli 0.167.0' ;;",
          `  "app-server daemon version") ${version} ;;`,
          `  "app-server daemon stop") ${stop} ;;`,
          `  "app-server daemon start") echo '{"status":"started"}' ;;`,
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

    it("warms the catalog, stops the daemon and starts a new one from the Codex home", async () => {
      const daemon = startFakeDaemon(daemonBin(), pidFile());
      const codex = fakeCodex({ version: "running", stop: "works" });
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      const calls = codex.calls();
      expect(calls).toContain(`CODEX_HOME=${codexHome()} cwd=`);
      expect(calls.indexOf("debug models")).toBeLessThan(calls.indexOf("daemon stop"));
      expect(calls.indexOf("daemon stop")).toBeLessThan(calls.indexOf("daemon start"));
      expect(calls).toContain(`cwd=${codexHome()} app-server daemon start`);
      expect(await waitGone(daemon)).toBe(true);
      expect(result.stderr).toContain("Restarted the Codex app-server daemon");
    });

    it("kills the daemon itself when `daemon stop` fails", async () => {
      const daemon = startFakeDaemon(daemonBin(), pidFile());
      const codex = fakeCodex({ version: "running", stop: "broken" });
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      expect(await waitGone(daemon)).toBe(true);
      expect(codex.calls()).toContain("app-server daemon start");
      expect(result.stderr).toContain("Restarted the Codex app-server daemon");
    });

    it("finds a stuck daemon without a pid file by its binary under the Codex home", async () => {
      const daemon = startFakeDaemon(daemonBin());
      const codex = fakeCodex({ version: "hang", stop: "broken" });
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      expect(await waitGone(daemon)).toBe(true);
      expect(codex.calls()).toContain("app-server daemon start");
    });

    it("leaves app-servers that do not belong to this Codex home alone", async () => {
      const other = startFakeDaemon(path.join(home, "ide", "bin"));
      const otherHome = startFakeDaemon(
        path.join(home, "other-codex", "packages", "app-server-daemon", "bin")
      );
      const codex = fakeCodex({ version: "stopped" });
      const result = await run(["codex"], `${GOOD_KEY}\n`, codex.env);
      expect(result.code, result.stderr).toBe(0);
      expect(codex.calls()).not.toContain("daemon stop");
      expect(alive(other)).toBe(true);
      expect(alive(otherHome)).toBe(true);
      expect(result.stderr).not.toContain("daemon");
    });

    it("only prints the restart command when CCH_RESTART_CODEX_DAEMON=0", async () => {
      const daemon = startFakeDaemon(daemonBin(), pidFile());
      const codex = fakeCodex({ version: "running", stop: "works" });
      const result = await run(["codex"], `${GOOD_KEY}\n`, {
        ...codex.env,
        CCH_RESTART_CODEX_DAEMON: "0",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(codex.calls()).not.toContain("daemon stop");
      expect(alive(daemon)).toBe(true);
      expect(result.stderr).toContain("codex app-server daemon restart");
    });

    it("skips everything when codex is not installed", async () => {
      const result = await run(["codex"], `${GOOD_KEY}\n`);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("daemon");
      expect(result.stderr).not.toContain("catalog fetched");
    });
  });

  describe("reusing an existing key", () => {
    function writeCodexConfig(body: string) {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), body);
    }
    const keyFile = () => fs.readFileSync(path.join(home, ".codex", "cch.key"), "utf8").trim();

    it("reuses a working bearer token from a jackllm4sci.online provider", async () => {
      writeCodexConfig(
        [
          'model_provider = "crs"',
          "[model_providers.crs]",
          'base_url = "https://crs.jackllm4sci.online/v1"',
          `#experimental_bearer_token = "sk-commented-out"`,
          `experimental_bearer_token = "${GOOD_KEY}"`,
          "",
        ].join("\n")
      );
      const result = await run(["codex"], "");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        `provider "crs" (crs.jackllm4sci.online), ending in ...${GOOD_KEY.slice(-4)}`
      );
      expect(result.stderr).toContain("Reusing the existing key.");
      expect(result.stderr).not.toContain(GOOD_KEY);
      expect(keyFile()).toBe(GOOD_KEY);
    });

    it("reuses the key file of an auth-command provider (a previous run)", async () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      const old = path.join(home, ".codex", "old.key");
      fs.writeFileSync(old, `${GOOD_KEY}\n`);
      writeCodexConfig(
        [
          "[model_providers.cch]",
          'base_url = "https://cch-daily-dev.jackllm4sci.online/v1"',
          "",
          "[model_providers.cch.auth]",
          'command = "cat"',
          `args = ["${old}"]`,
          "",
        ].join("\n")
      );
      const result = await run(["codex"], "");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("Reusing the existing key.");
      expect(keyFile()).toBe(GOOD_KEY);
    });

    it("reuses a key hard-coded in an omp provider", async () => {
      fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".omp", "agent", "models.yml"),
        `providers:\n  jk:\n    baseUrl: https://cch.jackllm4sci.online/responses/v1\n    apiKey: "${GOOD_KEY}"\n`
      );
      const result = await run(["codex"], "");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('provider "jk" (cch.jackllm4sci.online)');
      expect(keyFile()).toBe(GOOD_KEY);
    });

    it.each([
      [
        "a provider with requires_openai_auth",
        `[model_providers.oa]\nbase_url = "https://oa.jackllm4sci.online/v1"\nrequires_openai_auth = true\n`,
        'provider "oa" (oa.jackllm4sci.online)',
      ],
      [
        "the built-in provider moved by openai_base_url",
        `openai_base_url = "https://cpa.jackllm4sci.online/v1"\n[tui]\nx = 1\n`,
        'provider "openai" (cpa.jackllm4sci.online)',
      ],
    ])("reuses OPENAI_API_KEY from auth.json for %s", async (_label, config, expected) => {
      writeCodexConfig(config);
      fs.writeFileSync(
        path.join(home, ".codex", "auth.json"),
        `{\n  "auth_mode": "apikey",\n  "OPENAI_API_KEY": "${GOOD_KEY}",\n  "tokens": null\n}\n`
      );
      const result = await run(["codex"], "");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).toContain("auth.json");
      expect(keyFile()).toBe(GOOD_KEY);
    });

    it("ignores an auth.json without an API key", async () => {
      writeCodexConfig(
        `[model_providers.oa]\nbase_url = "https://oa.jackllm4sci.online/v1"\nrequires_openai_auth = true\n`
      );
      fs.writeFileSync(
        path.join(home, ".codex", "auth.json"),
        '{"auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": {}}\n'
      );
      const result = await run(["codex"], `${GOOD_KEY}\n`);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("Found a working key");
    });

    it("ignores providers outside the domain and asks for a key", async () => {
      writeCodexConfig(
        `[model_providers.other]\nbase_url = "https://cpa1.zenkexi.com/v1"\nexperimental_bearer_token = "${GOOD_KEY}"\n`
      );
      const result = await run(["codex"], "");
      expect(result.code).not.toBe(0);
      expect(result.stderr).not.toContain("Found a working key");
      expect(result.stderr).toContain("The key is empty.");
    });

    it("falls back to a typed key when the existing one is rejected", async () => {
      writeCodexConfig(
        `[model_providers.crs]\nbase_url = "https://crs.jackllm4sci.online/v1"\nexperimental_bearer_token = "sk-stale-key"\n`
      );
      const result = await run(["codex"], `${GOOD_KEY}\n`);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("does not work for");
      expect(result.stderr).not.toContain("Reusing the existing key.");
      expect(keyFile()).toBe(GOOD_KEY);
    });

    it("never reuses with CCH_REUSE_KEY=0, and reuses without asking with =1", async () => {
      writeCodexConfig(
        `[model_providers.crs]\nbase_url = "https://crs.jackllm4sci.online/v1"\nexperimental_bearer_token = "${GOOD_KEY}"\n`
      );
      const off = await run(["codex"], `${GOOD_KEY}\n`, { CCH_REUSE_KEY: "0" });
      expect(off.code, off.stderr).toBe(0);
      expect(off.stderr).not.toContain("Found a working key");

      writeCodexConfig(
        `[model_providers.crs]\nbase_url = "https://crs.jackllm4sci.online/v1"\nexperimental_bearer_token = "${GOOD_KEY}"\n`
      );
      const on = await run(["codex"], "", { CCH_REUSE_KEY: "1" });
      expect(on.code, on.stderr).toBe(0);
      expect(on.stderr).toContain("Reusing the existing key.");
    });

    it("honors CCH_REUSE_KEY_DOMAIN", async () => {
      writeCodexConfig(
        `[model_providers.x]\nbase_url = "https://gw.example.org/v1"\nexperimental_bearer_token = "${GOOD_KEY}"\n`
      );
      const result = await run(["codex"], "", { CCH_REUSE_KEY_DOMAIN: "example.org" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('provider "x" (gw.example.org)');
    });
  });

  it("reports an unreachable gateway", async () => {
    const result = await run(["codex"], `${GOOD_KEY}\n`, { CCH_HOST: "http://127.0.0.1:1" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot reach");
  });
});
