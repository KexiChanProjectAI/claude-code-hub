/**
 * Generates the shared TS <-> Go edge-executor fixtures under
 * tests/fixtures/edge/body/ by calling the *real* TS reference
 * implementations (buildRequestDigest, applyBodyOps, stableStringify,
 * detectUpstreamErrorFromSseOrJsonText). The Go packages under
 * edge/internal/{ojson,digest,bodyops,detect} are ported against these
 * fixtures and must reproduce the recorded output exactly.
 *
 * Run from the repo root: `bun scripts/edge-fixtures/body.ts`
 *
 * Notes on loading the real TS modules from a standalone bun script:
 * - digest.ts pulls in session.ts / session-manager.ts, which transitively
 *   import a module tagged `server-only`. Next.js strips that import via a
 *   bundler alias; bun has no such alias, so we register a Bun.plugin that
 *   replaces `server-only` with an empty module before dynamically importing
 *   the reference modules (dynamic import so the plugin is registered first;
 *   a static top-level import would resolve before this file's body runs).
 * - `@/` path aliases resolve fine under bun (tsconfig `paths` is honored),
 *   so we use them directly instead of relative imports.
 */
import { plugin } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

plugin({
  name: "stub-server-only",
  setup(build) {
    build.module("server-only", () => ({ contents: "export {};", loader: "js" }));
  },
});

const { buildRequestDigest } = await import("@/app/v1/_lib/edge/digest");
const { applyBodyOps } = await import("@/app/v1/_lib/edge/body-ops");
const { stableStringify } = await import("@/lib/request-identity");
const { detectUpstreamErrorFromSseOrJsonText } = await import(
  "@/lib/utils/upstream-error-detection"
);
type BodyOp = import("@/app/v1/_lib/edge/contract").BodyOp;

const OUT_DIR = path.resolve(import.meta.dir, "../../tests/fixtures/edge/body");

async function writeJSON(name: string, data: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`wrote ${name}`);
}

// ===================================================================
// digest.json
// ===================================================================

interface DigestCase {
  name: string;
  body: string; // raw JSON text, preserves exact numeric literals etc.
  path: string;
  method?: string;
  headers?: [string, string][];
  clientIp?: string | null;
  expected: unknown; // RequestDigest minus receivedAtMs/edgeId/edgeRequestId
}

function claudeBody(messages: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    system: "You are a helpful assistant.",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "bash",
        description: "Run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ],
    messages,
    ...overrides,
  });
}

const U1 = { role: "user", content: "hello" };
const A1 = { role: "assistant", content: [{ type: "text", text: "hi there" }] };
const U2 = { role: "user", content: "next question" };

function buildDigest(bodyText: string, path = "/v1/messages", method = "POST", headers: [string, string][] = [], clientIp: string | null = null) {
  const digest = buildRequestDigest({
    edgeId: "edge-fixture",
    edgeRequestId: "req-fixture",
    receivedAtMs: 1_700_000_000_000,
    method,
    path,
    headers,
    clientIp,
    body: JSON.parse(bodyText),
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
  });
  const { receivedAtMs: _r, edgeId: _e, edgeRequestId: _i, ...expected } = digest;
  return expected;
}

const digestCases: DigestCase[] = [];

function addDigest(name: string, bodyText: string, opts: Partial<DigestCase> = {}) {
  const p = opts.path ?? "/v1/messages";
  const method = opts.method ?? "POST";
  const headers = opts.headers ?? [];
  const clientIp = opts.clientIp ?? null;
  digestCases.push({
    name,
    body: bodyText,
    path: p,
    method,
    headers,
    clientIp,
    expected: buildDigest(bodyText, p, method, headers, clientIp),
  });
}

// --- basic determinism / structure ---
addDigest("claude_basic_chain", claudeBody([U1, A1, U2]));
addDigest("claude_prefix_extended", claudeBody([U1, A1, U2, { role: "user", content: "more" }]));
addDigest("claude_empty_messages", claudeBody([]));
addDigest("claude_missing_system_and_tools", JSON.stringify({ messages: [U1] }));
addDigest("claude_empty_content_array_skipped", claudeBody([{ role: "user", content: [] }, U1]));

// --- volatile key stripping ---
addDigest(
  "claude_tool_use_id_stripped",
  claudeBody([
    U1,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_aaa", name: "read_file", input: { path: "a.ts" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_aaa", content: "file body" }] },
  ])
);
addDigest(
  "claude_thinking_signature_not_hashed",
  claudeBody([
    U1,
    { role: "assistant", content: [{ type: "thinking", thinking: "step by step", signature: "sig-one" }] },
  ])
);
addDigest(
  "claude_unknown_block_type",
  claudeBody([
    U1,
    {
      role: "assistant",
      content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", payload: { q: "x" } }],
    },
  ])
);

// --- cache_control boundaries ---
addDigest(
  "claude_cache_control_boundary",
  claudeBody([
    U1,
    { role: "user", content: [{ type: "text", text: "long context", cache_control: { type: "ephemeral" } }] },
  ])
);

// --- window truncation (MAX_AFFINITY_WINDOW = 64) ---
addDigest(
  "claude_window_truncation_70_messages",
  claudeBody(
    Array.from({ length: 70 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }))
  )
);

// --- media digests ---
addDigest(
  "claude_media_image_base64",
  claudeBody([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAABBBB" } },
        { type: "text", text: "describe" },
      ],
    },
  ])
);
addDigest(
  "claude_media_document_url",
  claudeBody([
    { role: "user", content: [{ type: "document", source: { media_type: "application/pdf", url: "https://a.example/x.pdf" } }] },
  ])
);
addDigest(
  "claude_media_no_source",
  claudeBody([
    { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "image", source: null }] },
  ])
);

// --- tool ordering ---
addDigest(
  "claude_tools_reverse_order",
  claudeBody([U1], {
    tools: [
      { name: "bash", description: "Run a command", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ],
  })
);

// --- system as content-block array ---
addDigest(
  "claude_system_block_array",
  claudeBody([null, U1, { role: "assistant", content: ["raw string block", null] }], {
    system: [{ type: "text", text: "block system" }, "loose text"],
  })
);

// --- unicode keys / private params ---
addDigest(
  "unicode_keys_and_private_params",
  JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: "你好😀 unicode text" },
      { role: "assistant", content: [{ type: "text", text: "reply" }], _internal: { _secret: "x" } },
    ],
    metadata: { user_id: "u1", _private: true, nested: { _alsoPrivate: 1 } },
  })
);

// --- topLevel number literal fidelity (compared canonically on the Go side) ---
addDigest(
  "top_level_number_literals",
  JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    messages: [U1],
    metadata: {
      n_exp: 1e21,
      n_neg_zero: -0,
      n_one_point_zero: 1.0,
      n_big_int: 12345678901234567890,
      n_small: 0.000001,
      n_tiny_exp: 1e-7,
    },
  })
);

// --- probe requests ---
addDigest("probe_foo", JSON.stringify({ messages: [{ role: "user", content: "foo" }] }));
addDigest("probe_count_uppercase_trimmed", JSON.stringify({ messages: [{ role: "user", content: "  COUNT  " }] }));
addDigest("not_probe_two_messages", JSON.stringify({ messages: [{ role: "user", content: "foo" }, { role: "user", content: "bar" }] }));
addDigest("not_probe_content_array", JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "foo" }] }] }));
addDigest("not_probe_wrong_text", JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));

// --- warmup requests ---
addDigest(
  "warmup_valid",
  JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "text", text: "Warmup", cache_control: { type: "ephemeral" } }] },
    ],
  }),
  { path: "/v1/messages" }
);
addDigest(
  "warmup_wrong_path",
  JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "text", text: "Warmup", cache_control: { type: "ephemeral" } }] },
    ],
  }),
  { path: "/v1/messages/count_tokens" }
);
addDigest(
  "warmup_missing_cache_control",
  JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }] }),
  { path: "/v1/messages" }
);
addDigest(
  "warmup_case_insensitive_trimmed",
  JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "text", text: "  warmup  ", cache_control: { type: "ephemeral" } }] },
    ],
  }),
  { path: "/v1/messages?beta=true" }
);

// --- messagesHash ---
addDigest("messages_hash_string_content", JSON.stringify({ messages: [{ role: "user", content: "hi there" }] }));
addDigest(
  "messages_hash_array_text_blocks",
  JSON.stringify({
    messages: [{ role: "user", content: [{ type: "text", text: "part1" }, { type: "image", source: {} }, { type: "text", text: "part2" }] }],
  })
);
addDigest(
  "messages_hash_uses_first_three_only",
  JSON.stringify({
    messages: [
      { role: "user", content: "m1" },
      { role: "assistant", content: "m2" },
      { role: "user", content: "m3" },
      { role: "assistant", content: "m4 (ignored)" },
    ],
  })
);
addDigest("messages_hash_no_extractable_content", JSON.stringify({ messages: [{ role: "user", content: 42 }] }));
addDigest("messages_hash_empty_messages", JSON.stringify({ messages: [] }));

await writeJSON("digest.json", digestCases);

// ===================================================================
// stable-stringify.json
// ===================================================================

interface StableCase {
  name: string;
  value: string; // JSON text of the input value
  expected: string;
}

const stableCases: StableCase[] = [];
function addStable(name: string, valueText: string) {
  stableCases.push({ name, value: valueText, expected: stableStringify(JSON.parse(valueText)) });
}

addStable("null_value", "null");
addStable("bool_true", "true");
addStable("bool_false", "false");
addStable("empty_object", "{}");
addStable("empty_array", "[]");
addStable("simple_object_key_order", JSON.stringify({ b: 1, a: 2, c: 3 }));
addStable("nested_object_and_array", JSON.stringify({ z: [1, 2, { y: 1, x: 2 }], a: { nested: true } }));
addStable("string_escapes", JSON.stringify({ s: "quote\" backslash\\ tab\tnewline\ncontrol\u0001" }));
addStable("unicode_and_emoji", JSON.stringify({ "中文": 1, emoji: "😀", plain: "z" }));
addStable(
  "utf16_key_ordering_astral_vs_bmp",
  JSON.stringify({ "￿": 1, "😀hi": 2, a: 3, "": 4 })
);
addStable("number_variants", JSON.stringify({ a: 1.0, b: -0, c: 1e21, d: 0.000001, e: 1e-7, f: 100 }));
addStable("array_of_mixed", JSON.stringify([1, "two", true, null, { k: "v" }, [1, 2]]));
addStable("big_integer_literal_precision", JSON.stringify({ big: 12345678901234567890 }));

await writeJSON("stable-stringify.json", stableCases);

// ===================================================================
// js-number.json
// ===================================================================

interface JSNumberCase {
  literal: string;
  expected: string;
}

const numberLiterals = [
  "0",
  "-0",
  "1",
  "-1",
  "100",
  "1.5",
  "1.0",
  "0.1",
  "0.000001",
  "1e-6",
  "1e-7",
  "2.5e-10",
  "123.456",
  "-123.456",
  "1e20",
  "1e21",
  "1e22",
  "1e100",
  "9007199254740993",
  "12345678901234567890",
  "3.14159265358979",
  "5e-7",
  "9.999999999999999e20",
  "1234567890123456789012345",
  "0.00001234",
];

const jsNumberCases: JSNumberCase[] = numberLiterals.map((literal) => ({
  literal,
  expected: Number(literal).toString(),
}));

await writeJSON("js-number.json", jsNumberCases);

// ===================================================================
// bodyops.json
// ===================================================================

interface BodyOpsCase {
  name: string;
  body: string; // raw JSON text
  ops: BodyOp[];
  expectedBody: string; // TS JSON.stringify(result.message) output text
  expectedOpResults: unknown;
}

const bodyOpsCases: BodyOpsCase[] = [];
function addBodyOps(name: string, bodyText: string, ops: BodyOp[]) {
  const { message, opResults } = applyBodyOps(JSON.parse(bodyText), ops);
  bodyOpsCases.push({
    name,
    body: bodyText,
    ops,
    expectedBody: JSON.stringify(message),
    expectedOpResults: opResults,
  });
}

// --- set_top_level / delete_top_level (order semantics) ---
addBodyOps(
  "set_top_level_existing_key_keeps_position",
  JSON.stringify({ model: "old-model", max_tokens: 100, stream: true }),
  [{ op: "set_top_level", key: "model", value: "new-model" }]
);
addBodyOps("set_top_level_new_key_appended", JSON.stringify({ model: "m", stream: true }), [
  { op: "set_top_level", key: "max_tokens", value: 2048 },
]);
addBodyOps(
  "delete_top_level_existing",
  JSON.stringify({ model: "m", max_tokens: 100, stream: true }),
  [{ op: "delete_top_level", key: "max_tokens" }]
);
addBodyOps("delete_top_level_missing_noop", JSON.stringify({ model: "m" }), [
  { op: "delete_top_level", key: "max_tokens" },
]);
addBodyOps(
  "set_top_level_object_value",
  JSON.stringify({ model: "m" }),
  [{ op: "set_top_level", key: "metadata", value: { user_id: "u1", nested: { a: 1 } } }]
);

// --- remove_system_billing_header (billing-header-rectifier.test.ts) ---
addBodyOps(
  "billing_header_array_single_block",
  JSON.stringify({
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.36; cc_entrypoint=cli; cch=1;" }],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_array_multiple_blocks",
  JSON.stringify({
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.36;" },
      { type: "text", text: "x-anthropic-billing-header: cc_entrypoint=cli;" },
    ],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_array_no_match",
  JSON.stringify({
    system: [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: "Follow instructions carefully." },
    ],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_array_mixed_with_prompts",
  JSON.stringify({
    system: [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.36; cch=1;" },
      { type: "text", text: "Follow instructions carefully." },
    ],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_plain_string_match",
  JSON.stringify({ system: "x-anthropic-billing-header: cc_version=2.1.36;" }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps("billing_header_plain_string_no_match", JSON.stringify({ system: "You are a helpful assistant." }), [
  { op: "remove_system_billing_header" },
]);
addBodyOps("billing_header_missing_system", JSON.stringify({ model: "claude-3" }), [
  { op: "remove_system_billing_header" },
]);
addBodyOps("billing_header_null_system", JSON.stringify({ system: null }), [
  { op: "remove_system_billing_header" },
]);
addBodyOps(
  "billing_header_mid_string_not_removed",
  JSON.stringify({
    system: [{ type: "text", text: "Some preamble text x-anthropic-billing-header: cc_version=2.1.36;" }],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_case_insensitive",
  JSON.stringify({ system: [{ type: "text", text: "X-Anthropic-Billing-Header: cc_version=2.1.36;" }] }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_various_formats",
  JSON.stringify({
    system: [
      { type: "text", text: "x-anthropic-billing-header:cc_version=2.1.36" },
      { type: "text", text: "  x-anthropic-billing-header: cc_version=2.2.0; cc_entrypoint=vscode;" },
      { type: "text", text: "x-anthropic-billing-header:  " },
    ],
  }),
  [{ op: "remove_system_billing_header" }]
);
addBodyOps(
  "billing_header_non_text_blocks_preserved",
  JSON.stringify({
    system: [
      { type: "image", source: { type: "base64" } },
      { type: "text", text: "x-anthropic-billing-header: val" },
      { type: "text", text: "Keep this" },
    ],
  }),
  [{ op: "remove_system_billing_header" }]
);

// --- set_cache_control_ttl (forwarder.ts applyCacheTtlOverrideToMessage) ---
addBodyOps(
  "cache_ttl_system_array_ephemeral_1h",
  JSON.stringify({ system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] }),
  [{ op: "set_cache_control_ttl", ttl: "1h" }]
);
addBodyOps(
  "cache_ttl_messages_content_ephemeral_5m",
  JSON.stringify({
    messages: [{ role: "user", content: [{ type: "text", text: "ctx", cache_control: { type: "ephemeral" } }] }],
  }),
  [{ op: "set_cache_control_ttl", ttl: "5m" }]
);
addBodyOps(
  "cache_ttl_non_ephemeral_skipped",
  JSON.stringify({ system: [{ type: "text", text: "sys", cache_control: { type: "persistent" } }] }),
  [{ op: "set_cache_control_ttl", ttl: "1h" }]
);
addBodyOps(
  "cache_ttl_no_cache_control_noop",
  JSON.stringify({ system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hi" }] }),
  [{ op: "set_cache_control_ttl", ttl: "1h" }]
);
addBodyOps(
  "cache_ttl_overwrites_existing_ttl",
  JSON.stringify({
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "5m" } }],
  }),
  [{ op: "set_cache_control_ttl", ttl: "1h" }]
);

// --- apply_thinking_signature_rectifier (thinking-signature-rectifier.test.ts) ---
addBodyOps(
  "thinking_removes_thinking_and_signature_fields",
  JSON.stringify({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "sig_thinking" },
          { type: "text", text: "hello", signature: "sig_text_should_remove" },
          { type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "q" }, signature: "sig_tool_should_remove" },
          { type: "redacted_thinking", data: "r", signature: "sig_redacted" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  }),
  [{ op: "apply_thinking_signature_rectifier" }]
);
addBodyOps("thinking_no_messages_noop", JSON.stringify({ model: "claude-test" }), [
  { op: "apply_thinking_signature_rectifier" },
]);
addBodyOps(
  "thinking_removes_top_level_when_tool_use_prefix_missing",
  JSON.stringify({
    model: "claude-test",
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "q" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
  }),
  [{ op: "apply_thinking_signature_rectifier" }]
);
addBodyOps(
  "thinking_missing_signature_field_removes_and_clears_top_level",
  JSON.stringify({
    model: "claude-3-5-sonnet-20241022",
    thinking: { type: "enabled", budget_tokens: 10000 },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this..." },
          { type: "tool_use", id: "toolu_01", name: "WebSearch", input: { query: "test" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "search result" }] },
    ],
  }),
  [{ op: "apply_thinking_signature_rectifier" }]
);
addBodyOps(
  "thinking_starts_with_thinking_block_top_level_kept",
  JSON.stringify({
    model: "claude-test",
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ok", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "q" } },
        ],
      },
    ],
  }),
  [{ op: "apply_thinking_signature_rectifier" }]
);

// --- strip_private_params (forwarder.ts filterPrivateParameters) ---
addBodyOps(
  "strip_private_params_nested",
  JSON.stringify({
    model: "m",
    _debug: true,
    metadata: { user_id: "u1", _trace: "x" },
    messages: [{ role: "user", content: "hi", _extra: 1 }],
  }),
  [{ op: "strip_private_params" }]
);
addBodyOps(
  "strip_private_params_arrays",
  JSON.stringify({ items: [{ a: 1, _b: 2 }, { _c: 3, d: 4 }] }),
  [{ op: "strip_private_params" }]
);
addBodyOps("strip_private_params_none_present", JSON.stringify({ model: "m", max_tokens: 10 }), [
  { op: "strip_private_params" },
]);

// --- op chaining ---
addBodyOps(
  "chain_set_then_strip_then_ttl",
  JSON.stringify({
    model: "old",
    _junk: 1,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  }),
  [
    { op: "set_top_level", key: "model", value: "new-model" },
    { op: "strip_private_params" },
    { op: "set_cache_control_ttl", ttl: "1h" },
  ]
);

await writeJSON("bodyops.json", bodyOpsCases);

// ===================================================================
// detect.json
// ===================================================================

interface DetectCase {
  name: string;
  bodyText: string;
  expected: { isError: boolean; code?: string };
}

const detectCases: DetectCase[] = [];
function addDetect(name: string, bodyText: string) {
  const detected = detectUpstreamErrorFromSseOrJsonText(bodyText, { maxJsonCharsForMessageCheck: 0 });
  detectCases.push({
    name,
    bodyText,
    expected: detected.isError ? { isError: true, code: detected.code } : { isError: false },
  });
}

addDetect("empty_body", "");
addDetect("whitespace_only_body", "   \n\t  ");
addDetect("html_doctype", "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>");
addDetect("html_tag_only", "<html><head></head><body>error</body></html>");
addDetect("not_html_angle_bracket_text", "<tag>not really html</tag>");
addDetect("json_error_string_non_empty", JSON.stringify({ error: "invalid api key" }));
addDetect("json_error_object_with_message", JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
addDetect("json_error_empty_string_not_error", JSON.stringify({ error: "" }));
addDetect("json_error_null_not_error", JSON.stringify({ error: null }));
addDetect("json_no_error_field", JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }] }));
addDetect(
  "json_message_keyword_not_checked_because_max_chars_zero",
  JSON.stringify({ message: "an error occurred processing your request" })
);
addDetect(
  "openai_responses_failed_status",
  JSON.stringify({ id: "resp_123", object: "response", status: "failed", error: { message: "server error", code: "server_error" } })
);
addDetect(
  "openai_responses_failed_event_type",
  JSON.stringify({ type: "response.failed", response: { id: "resp_456", status: "failed", error: "boom" } })
);
addDetect("openai_responses_completed_not_error", JSON.stringify({ id: "resp_789", object: "response", status: "completed" }));
addDetect("plain_array_not_error", JSON.stringify([1, 2, 3]));
addDetect("malformed_json_not_error", "{not valid json");

await writeJSON("detect.json", detectCases);

console.log("done");
