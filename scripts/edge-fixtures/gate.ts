/**
 * Generates JSON fixtures for the Go port of the stream content gate
 * (edge/internal/sse, edge/internal/gate) by driving the REAL TypeScript
 * implementations. Run with:
 *
 *   bun scripts/edge-fixtures/gate.ts
 *
 * from the repo root. Output is deterministic: re-running produces byte
 * identical files (no timestamps/randomness in the emitted JSON; the one
 * pseudo-random case below uses a fixed seed).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFrame,
  isRequestEchoFrame,
  isCleanResponsesCompletion,
  isResponsesIncompleteCompletion,
  classifyStructuredTerminalKind,
  classifyTerminalKind,
  type ProtocolFamily,
} from "../../src/app/v1/_lib/proxy/stream-gate/frame-classifier";
import {
  parseSseBody,
  SseFrameBufferLimitError,
  SseFrameParser,
} from "../../src/app/v1/_lib/proxy/stream-gate/sse-frames";
import {
  concatChunks,
  runStreamContentGate,
  StreamPrecommitError,
} from "../../src/app/v1/_lib/proxy/stream-gate/stream-content-gate";
import { createStreamProtocolObserver } from "../../src/app/v1/_lib/proxy/stream-gate/stream-protocol-observer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../../tests/fixtures/edge/gate");
mkdirSync(OUT_DIR, { recursive: true });

function writeJson(name: string, value: unknown): void {
  const path = join(OUT_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote ${path}`);
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// sse-frames.json
// ---------------------------------------------------------------------------

interface SseFrameCase {
  name: string;
  chunks: string[];
  // When set, `chunks` are base64-encoded raw bytes instead of plain UTF-8
  // text. This is required for chunk boundaries that land mid-UTF-8-codepoint:
  // round-tripping such a chunk through a plain JSON string (decode as text,
  // even partially) would corrupt it, since a partial codepoint decodes to a
  // replacement character. Byte-split cases must therefore preserve the
  // exact wire bytes end to end.
  binary?: boolean;
  maxBufferedBytes?: number;
  exemptionEventName?: string;
  expectedFrames?: { eventName: string | null; data: string }[];
  expectedError?: boolean;
}

function encodeChunk(c: SseFrameCase, chunk: string): Uint8Array {
  return c.binary ? Uint8Array.from(Buffer.from(chunk, "base64")) : encoder.encode(chunk);
}

function runSseCase(c: SseFrameCase): { frames?: { eventName: string | null; data: string }[]; error?: boolean } {
  const options: ConstructorParameters<typeof SseFrameParser>[0] = {};
  if (c.maxBufferedBytes !== undefined) options.maxBufferedCharacters = c.maxBufferedBytes;
  if (c.exemptionEventName !== undefined) {
    options.bufferLimitExemption = {
      maxBufferedCharacters: Number.MAX_SAFE_INTEGER,
      matches: (eventName) => eventName === c.exemptionEventName,
    };
  }
  const parser = new SseFrameParser(options);
  try {
    const frames = c.chunks.flatMap((chunk) => parser.push(encodeChunk(c, chunk)));
    frames.push(...parser.finish());
    return { frames };
  } catch (error) {
    if (error instanceof SseFrameBufferLimitError) return { error: true };
    throw error;
  }
}

const sseFrameCases: SseFrameCase[] = [
  {
    name: "simple event stream",
    chunks: ['event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n'],
  },
  {
    name: "joins multi-line data with newline",
    chunks: ["data: line1\ndata: line2\n\n"],
  },
  {
    name: "CRLF line endings",
    chunks: ["event: ping\r\ndata: {}\r\n\r\n"],
  },
  {
    name: "skips comment lines and id/retry fields",
    chunks: [": keep-alive\nid: 42\nretry: 500\ndata: x\n\n"],
  },
  {
    name: "newline-delimited raw JSON frames",
    chunks: ['{"candidates":[]}\n{"error":{"message":"failed"}}\n'],
  },
  {
    name: "event without data emits no frame and resets event name",
    chunks: ["event: orphan\n\ndata: y\n\n"],
  },
  {
    name: "trailing frame without terminating blank line at EOF",
    chunks: ['event: e\ndata: {"z":1}'],
  },
  {
    name: "strips exactly one leading space after data:",
    chunks: ["data:  two-spaces\n\ndata:none\n\n"],
  },
  {
    name: "CRLF split across chunk boundary",
    chunks: ["data: a\r", "\ndata: b\r\n\r\n"],
  },
  {
    name: "unterminated line exceeding retained buffer throws",
    chunks: [`data: ${"x".repeat(20)}`],
    maxBufferedBytes: 16,
    expectedError: true,
  },
  {
    name: "completed oversized unknown line throws",
    chunks: [`unknown: ${"x".repeat(20)}\n`],
    maxBufferedBytes: 16,
    expectedError: true,
  },
  {
    name: "counts accumulated data lines before dispatch",
    chunks: ["data: 12345\ndata: 67890\n"],
    maxBufferedBytes: 10,
    expectedError: true,
  },
  {
    name: "does not count an event name after a later event field replaces it",
    chunks: ["event: 1234567890\nevent: abcdefghij\ndata: x\n\n"],
    maxBufferedBytes: 11,
  },
  {
    name: "keeps unlimited behavior when no limit configured",
    chunks: [`data: ${"x".repeat(1024 * 1024 + 1)}\n\n`],
  },
  {
    name: "event-name-only buffer exemption allows an oversized recognized frame",
    chunks: [`event: response.created\ndata: ${"x".repeat(200)}\n\n`],
    maxBufferedBytes: 16,
    exemptionEventName: "response.created",
  },
  {
    name: "exemption does not apply to a non-matching event",
    chunks: [`event: other\ndata: ${"x".repeat(200)}\n\n`],
    maxBufferedBytes: 16,
    exemptionEventName: "response.created",
    expectedError: true,
  },
];

interface ByteSplitCase {
  name: string;
  body: string;
  splits: number[]; // byte offsets to split at (two chunks each), plus "every-byte" flag handled separately
  everyByte?: boolean;
}

const byteSplitCases: ByteSplitCase[] = [
  { name: "utf8 codepoint split", body: "data: 中文内容\n\n", splits: [8] },
  {
    name: "byte-split invariance: arbitrary points",
    body:
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"你好"}}\r\n\r\n' +
      ": comment\n" +
      "data: part1\ndata: part2\n\n" +
      "event: message_stop\ndata: {}\n\n" +
      "data: [DONE]\n\n",
    splits: [],
    everyByte: true,
  },
  {
    name: "byte-split invariance: byte-by-byte, trailing unterminated frame",
    body: 'event: e1\ndata: {"a":"中"}\n\ndata: tail',
    splits: [],
    everyByte: true,
  },
];

function framesToJson(frames: { eventName: string | null; data: string }[]) {
  return frames.map((f) => ({ eventName: f.eventName, data: f.data }));
}

const sseFrameFixture: unknown[] = [];

for (const c of sseFrameCases) {
  const outcome = runSseCase(c);
  sseFrameFixture.push({
    name: c.name,
    chunks: c.chunks,
    binary: c.binary === true,
    maxBufferedBytes: c.maxBufferedBytes ?? null,
    exemptionEventName: c.exemptionEventName ?? null,
    expectedFrames: outcome.frames ? framesToJson(outcome.frames) : null,
    expectedError: outcome.error === true,
  });
}

for (const bc of byteSplitCases) {
  const bytes = encoder.encode(bc.body);
  const expected = framesToJson(parseSseBody(bc.body));
  const splitPoints = bc.everyByte
    ? Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)
    : bc.splits;
  for (const splitAt of splitPoints) {
    const parser = new SseFrameParser();
    const frames = [
      ...parser.push(bytes.slice(0, splitAt)),
      ...parser.push(bytes.slice(splitAt)),
      ...parser.finish(),
    ];
    const actual = framesToJson(frames);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`byte-split mismatch for "${bc.name}" at split=${splitAt}`);
    }
  }
  const sampleSplits = bc.everyByte
    ? [splitPoints[0], splitPoints[Math.floor(splitPoints.length / 2)], splitPoints[splitPoints.length - 1]]
    : splitPoints;
  for (const splitAt of sampleSplits) {
    sseFrameFixture.push({
      name: `${bc.name} (byte-split invariant, split=${splitAt})`,
      chunks: [
        Buffer.from(bytes.slice(0, splitAt)).toString("base64"),
        Buffer.from(bytes.slice(splitAt)).toString("base64"),
      ],
      binary: true,
      maxBufferedBytes: null,
      exemptionEventName: null,
      expectedFrames: expected,
      expectedError: false,
    });
  }
}

writeJson("sse-frames.json", sseFrameFixture);

// ---------------------------------------------------------------------------
// classifier.json
// ---------------------------------------------------------------------------

const families: ProtocolFamily[] = ["anthropic", "openai-chat", "openai-responses", "gemini"];

const classifierSamples: { eventName: string | null; data: string }[] = [
  { eventName: "message_start", data: '{"type":"message_start","message":{"id":"m1"}}' },
  {
    eventName: "content_block_delta",
    data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
  },
  {
    eventName: "content_block_start",
    data: '{"type":"content_block_start","content_block":{"type":"tool_use","name":"lookup"}}',
  },
  {
    eventName: "content_block_start",
    data: '{"type":"content_block_start","content_block":{"type":"redacted_thinking"}}',
  },
  { eventName: "message_stop", data: '{"type":"message_stop"}' },
  { eventName: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}' },
  { eventName: null, data: '{"error":{"message":"failed"}}' },
  { eventName: null, data: '{"choices":[{"delta":{"content":"hi"}}]}' },
  { eventName: null, data: '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}' },
  { eventName: null, data: "[DONE]" },
  {
    eventName: "response.output_text.delta",
    data: '{"type":"response.output_text.delta","delta":"ok"}',
  },
  {
    eventName: "response.output_text.delta",
    data: '{"type":"response.output_text.delta","delta":"ok","error":{"message":"failed"}}',
  },
  {
    eventName: "response.completed",
    data: '{"type":"response.completed","response":{"status":"completed","output":[]}}',
  },
  {
    eventName: "response.completed",
    data: '{"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"opaque"}]}}',
  },
  {
    eventName: "response.completed",
    data: '{"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction"},{"encrypted_content":"opaque"}]}}',
  },
  {
    eventName: "response.output_item.done",
    data: '{"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque-state"}}',
  },
  {
    eventName: "response.incomplete",
    data: '{"type":"response.incomplete","response":{"status":"incomplete"}}',
  },
  {
    eventName: "response.completed",
    data: '{"type":"response.completed","response":{"status":"failed","output":[],"error":null}}',
  },
  {
    eventName: "response.completed",
    data: '{"type":"response.completed","response":{"status":"completed","output":[],"error":{"code":"server_error"}}}',
  },
  { eventName: "response.created", data: '{"type":"response.created","response":{"instructions":"echo"}}' },
  { eventName: null, data: '{"type":"response.created","response":{"instructions":"echo"}}' },
  { eventName: "response.failed", data: '{"type":"response.failed","response":{"status":"failed"}}' },
  {
    eventName: null,
    data: '{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
  },
  { eventName: null, data: '{"candidates":[{"finishReason":"STOP"}]}' },
  { eventName: null, data: '{"candidates":[{"finishReason":"SAFETY"}]}' },
  { eventName: null, data: '{"usageMetadata":{"totalTokenCount":1}}' },
  { eventName: null, data: '{"promptFeedback":{"blockReason":"SAFETY"}}' },
  {
    eventName: null,
    data: '{"response":{"candidates":[{"content":{"parts":[{"text":"yes"}]},"finishReason":"SAFETY"}]}}',
  },
  { eventName: null, data: "{}" },
  { eventName: null, data: "[]" },
  { eventName: null, data: "null" },
  { eventName: null, data: "" },
  { eventName: null, data: "   " },
  { eventName: null, data: "{broken}" },
  { eventName: null, data: "{not-json}" },
  { eventName: null, data: '{"error":false,"error":null}' },
  { eventName: null, data: '{"error":0}' },
  { eventName: null, data: '{"error":[false,null,"",[]]}' },
  { eventName: null, data: '{"error":[{}]}' },
  { eventName: null, data: '{"error":1e+2}' },
  { eventName: null, data: '{"error":01}' },
  { eventName: null, data: '{"error":1.}' },
  { eventName: null, data: '{"error":1e}' },
  { eventName: null, data: '{"error":true,}' },
  { eventName: null, data: '{"choices":{"#":{"delta":{"content":"wrong object wildcard"}}}}' },
  {
    eventName: null,
    data:
      '{"unused":' + "[".repeat(50) + "0" + "]".repeat(50) + ',"choices":[{"delta":{"content":"ok"}}]}',
  },
  { eventName: null, data: '{"choices":[{"delta":{"content":""}},{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}' },
];

// terminalKind mirrors the exact composition used by
// createStreamProtocolObserver's `record` function: a verdict-gated,
// event-name-only base (classifyTerminalKind, no parsed argument), then
// overridden by the structural classifyStructuredTerminalKind when a parsed
// JSON object/array is available and it returns non-null.
function computeTerminalKind(
  family: ProtocolFamily,
  eventName: string | null,
  data: string,
  verdict: string
): string {
  const trimmed = data.trim();
  let parsed: unknown = null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === "object") parsed = value;
    } catch {
      parsed = null;
    }
  }
  const base = verdict === "terminal" ? classifyTerminalKind(family, eventName) : null;
  const kind = parsed !== null ? (classifyStructuredTerminalKind(family, eventName, parsed as object) ?? base) : base;
  return kind ?? "";
}

const classifierFixture: unknown[] = [];
for (const family of families) {
  for (const sample of classifierSamples) {
    const verdict = classifyFrame(family, sample.eventName, sample.data);
    const acceptTerminal =
      family === "openai-responses" &&
      (isCleanResponsesCompletion(sample.eventName, sample.data) ||
        isResponsesIncompleteCompletion(sample.eventName, sample.data));
    classifierFixture.push({
      family,
      eventName: sample.eventName,
      data: sample.data,
      expected: {
        verdict,
        acceptTerminal,
        isEcho: isRequestEchoFrame(family, sample.eventName, sample.data),
        terminalKind: computeTerminalKind(family, sample.eventName, sample.data, verdict),
      },
    });
  }
}

// Deterministic pseudo-random differential samples (mirrors
// stream-gate-frame-probe.test.ts's "随机协议载荷差分" generator).
{
  let seed = 1473;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const values: unknown[] = [null, false, true, 0, "", "x", {}, [], [null], { x: null }, "SAFETY", "compaction"];
  for (let i = 0; i < 200; i++) {
    const choose = () => values[random(values.length)];
    const data = JSON.stringify({
      type: ["response.completed", "response.output_item.done", "content_block_delta"][random(3)],
      error: choose(),
      delta: { text: choose() },
      choices: [{ delta: { content: choose() } }],
      item: { type: choose(), encrypted_content: choose() },
      candidates: [{ finishReason: choose(), content: { parts: [{ text: choose() }] } }],
      response: { output: [{ type: choose() }, { encrypted_content: choose() }] },
    });
    for (const family of families) {
      const verdict = classifyFrame(family, null, data);
      const acceptTerminal =
        family === "openai-responses" &&
        (isCleanResponsesCompletion(null, data) || isResponsesIncompleteCompletion(null, data));
      classifierFixture.push({
        family,
        eventName: null,
        data,
        expected: {
          verdict,
          acceptTerminal,
          isEcho: isRequestEchoFrame(family, null, data),
          terminalKind: computeTerminalKind(family, null, data, verdict),
        },
      });
    }
  }
}

writeJson("classifier.json", classifierFixture);

// ---------------------------------------------------------------------------
// observer.json
// ---------------------------------------------------------------------------

interface ObserverCase {
  name: string;
  family: ProtocolFamily;
  chunks: string[]; // observed in order via observer.observe()
}

const observerCases: ObserverCase[] = [
  {
    name: "compaction content also counts as terminal completion",
    family: "openai-responses",
    chunks: [
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"opaque"}]}}\n\n',
    ],
  },
  {
    name: "gemini content with finishReason in same frame",
    family: "gemini",
    chunks: ['{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}\n'],
  },
  {
    name: "content then failure then terminal, EOF flush",
    family: "openai-responses",
    chunks: [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
    ],
  },
  {
    name: "malformed terminal-ish frame recorded as terminal failure",
    family: "anthropic",
    chunks: [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
      "event: message_stop\ndata: {not-json}\n\n",
    ],
  },
  {
    name: "explicit error overrides earlier malformed, keeps sawMalformed",
    family: "openai-responses",
    chunks: [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      "event: response.in_progress\ndata: not-json\n\n",
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    ],
  },
  {
    name: "tool metadata alone is not content",
    family: "anthropic",
    chunks: [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"lookup"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
  },
  {
    name: "content without terminal",
    family: "openai-chat",
    chunks: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
  },
  {
    name: "openai-chat DONE is success terminal",
    family: "openai-chat",
    chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"],
  },
  {
    name: "responses incomplete via event name",
    family: "openai-responses",
    chunks: ['event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'],
  },
  {
    name: "responses incomplete via bare data",
    family: "openai-responses",
    chunks: ['data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'],
  },
  {
    name: "finish flushes malformed frame with no terminating blank line",
    family: "openai-responses",
    chunks: ["event: response.completed\ndata: not-json"],
  },
];

const observerFixture: unknown[] = [];
for (const c of observerCases) {
  const observer = createStreamProtocolObserver(c.family);
  for (const chunk of c.chunks) observer.observe(encoder.encode(chunk));
  const result = observer.finish();
  observerFixture.push({
    name: c.name,
    family: c.family,
    chunks: c.chunks,
    expected: result,
  });
}

writeJson("observer.json", observerFixture);

// ---------------------------------------------------------------------------
// gate-cases.json
// ---------------------------------------------------------------------------

function readerFromChunks(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
  return stream.getReader();
}

interface GateCase {
  name: string;
  family: ProtocolFamily;
  chunks: string[];
  eventCap?: number;
  byteCap?: number;
}

const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const MESSAGE_START = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n';
const TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n';
const ERROR_FRAME =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const gateCases: GateCase[] = [
  { name: "commits on first content frame", family: "anthropic", chunks: [PING, MESSAGE_START, TEXT_DELTA, MESSAGE_STOP] },
  { name: "fails over on error before content", family: "anthropic", chunks: [PING, ERROR_FRAME, TEXT_DELTA] },
  { name: "fails on malformed frame", family: "anthropic", chunks: [PING, "data: {broken json\n\n"] },
  { name: "terminal before content is empty stream", family: "anthropic", chunks: [PING, MESSAGE_STOP] },
  { name: "EOF without content is empty stream", family: "anthropic", chunks: [PING, MESSAGE_START] },
  { name: "fully empty stream", family: "anthropic", chunks: [] },
  {
    name: "commits trailing content frame without terminating blank line",
    family: "anthropic",
    chunks: ['data: {"type":"content_block_delta","delta":{"text":"tail"}}'],
  },
  {
    name: "event cap overflow across many frames",
    family: "anthropic",
    chunks: Array.from({ length: 20 }, () => PING),
    eventCap: 10,
  },
  {
    name: "event cap overflow within a single chunk",
    family: "anthropic",
    chunks: [Array.from({ length: 20 }, () => PING).join("")],
    eventCap: 10,
  },
  {
    name: "commits right at event cap boundary",
    family: "anthropic",
    chunks: [PING + PING + PING + TEXT_DELTA],
    eventCap: 3,
  },
  {
    name: "byte cap overflow",
    family: "anthropic",
    chunks: [
      `event: ping\ndata: {"type":"ping","pad":"${"x".repeat(4000)}"}\n\n`,
      `event: ping\ndata: {"type":"ping","pad":"${"x".repeat(4000)}"}\n\n`,
      `event: ping\ndata: {"type":"ping","pad":"${"x".repeat(4000)}"}\n\n`,
    ],
    byteCap: 8000,
  },
  {
    name: "byte-fragmented prefix, one byte per chunk",
    family: "anthropic",
    chunks: [...encoder.encode(PING + MESSAGE_START + TEXT_DELTA)].map((byte) => String.fromCharCode(byte)),
  },
  {
    name: "openai-chat DONE-only stream is empty",
    family: "openai-chat",
    chunks: ["data: [DONE]\n\n"],
  },
  {
    name: "openai-chat in-stream error fails over",
    family: "openai-chat",
    chunks: [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"error":{"message":"rate limited","code":429}}\n\n',
    ],
  },
  {
    name: "openai-chat reasoning_content commits",
    family: "openai-chat",
    chunks: ['data: {"choices":[{"delta":{"reasoning_content":"reasoning step 0"}}]}\n\n'],
  },
  {
    name: "openai-responses commits compaction item before completed",
    family: "openai-responses",
    chunks: [
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque-state"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ],
  },
  {
    name: "openai-responses commits compaction carried only by response.completed",
    family: "openai-responses",
    chunks: [
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"opaque-state"}]}}\n\n',
    ],
  },
  {
    name: "gemini usage-only chunks buffer until content commits",
    family: "gemini",
    chunks: [
      'data: {"usageMetadata":{"totalTokenCount":1}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
    ],
  },
  {
    name: "openai-responses transparent empty completion (legal silent success)",
    family: "openai-responses",
    chunks: [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_empty","status":"in_progress","output":[]}}\n\n',
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":""}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_empty","status":"completed","output":[],"error":null}}\n\n',
    ],
  },
  {
    name: "openai-responses no-trailing-blank-line success completion at EOF",
    family: "openai-responses",
    chunks: [
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_empty","status":"completed","output":[],"error":null}}',
    ],
  },
  {
    name: "openai-responses explicit incomplete terminal is a legal completion",
    family: "openai-responses",
    chunks: [
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":8,"output_tokens":4}}}\n\n',
    ],
  },
  {
    name: "openai-responses rejects failed completion",
    family: "openai-responses",
    chunks: [
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"failed","output":[],"error":null}}\n\n',
    ],
  },
  {
    name: "openai-responses rejects completed-with-error",
    family: "openai-responses",
    chunks: [
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"completed","output":[],"error":{"code":"server_error"}}}\n\n',
    ],
  },
];

// Request-echo byte-cap exclusion cases (openai-responses)
{
  const bigPayload = "x".repeat(4096);
  const echoFrame = `event: response.created\ndata: {"type":"response.created","response":{"instructions":"${bigPayload}"}}\n\n`;
  const responsesDelta =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
  gateCases.push({
    name: "echo frame excluded from byte cap, commits",
    family: "openai-responses",
    chunks: [echoFrame, responsesDelta],
    byteCap: 4096,
  });
  gateCases.push({
    name: "echo exemption caps at prebufferByteCap, still overflows",
    family: "openai-responses",
    chunks: [echoFrame, responsesDelta],
    byteCap: 1024,
  });
  const bigNeutral = `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":"${bigPayload}"}\n\n`;
  gateCases.push({
    name: "oversized non-echo neutral frame still overflows",
    family: "openai-responses",
    chunks: [bigNeutral, responsesDelta],
    byteCap: 1024,
  });
}

interface GateExpected {
  committed: boolean;
  reason?: string;
  framesSeen: number;
  prefixBytes: number;
  readerDone?: boolean;
  terminalBeforeContent?: boolean;
  echoExcludedBytes?: number;
  commitMarker?: {
    frameIndex: number;
    chunkIndex: number;
    eventName: string | null;
    bufferedBytes: number;
    echoExcludedBytes: number;
  } | null;
}

const gateCaseFixture: unknown[] = [];
for (const c of gateCases) {
  const reader = readerFromChunks(c.chunks);
  const result = await runStreamContentGate(reader, {
    family: c.family,
    providerId: 1,
    providerName: "fixture-provider",
    prebufferEventCap: c.eventCap ?? 64,
    prebufferByteCap: c.byteCap ?? 256 * 1024,
    captureCommitMarker: true,
  });

  let expected: GateExpected;
  if (result.committed) {
    const merged = concatChunks(result.prefixChunks);
    const prefixBytes = merged ? merged.byteLength : 0;
    expected = {
      committed: true,
      framesSeen: result.framesSeen,
      prefixBytes,
      readerDone: result.readerDone,
      commitMarker: result.commitMarker,
    };
  } else {
    const error = result.error;
    if (!(error instanceof StreamPrecommitError)) {
      throw new Error(`case "${c.name}": expected StreamPrecommitError, got ${String(error)}`);
    }
    expected = {
      committed: false,
      reason: error.gateReason,
      framesSeen: 0,
      prefixBytes: 0,
      terminalBeforeContent: error.terminalBeforeContent,
    };
  }

  gateCaseFixture.push({
    name: c.name,
    family: c.family,
    chunks: c.chunks,
    eventCap: c.eventCap ?? 64,
    byteCap: c.byteCap ?? 256 * 1024,
    expected,
  });
}

writeJson("gate-cases.json", gateCaseFixture);

console.log("done");
