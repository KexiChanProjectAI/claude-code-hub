// Generates deterministic JSON fixtures for the Go ports of:
//   - src/app/v1/_lib/proxy/response-fixer/* (edge/internal/fixer)
//   - src/app/v1/_lib/proxy/client-abort-metering.ts (edge/internal/capture)
//   - a new "compact SSE capture" concept (edge/internal/capture/compact.go)
//
// Run from repo root: `bun scripts/edge-fixtures/fixer-capture.ts`
//
// Import notes (see final report for details):
//   - `@/` path aliases do not resolve under plain `bun run`, so this file
//     uses relative imports.
//   - response-handler.ts pulls in `server-only` (via its module graph) and
//     cannot be imported from a plain script. `parseUsageFromResponseText`
//     (and its helper `extractUsageMetrics`) are therefore reimplemented
//     below as a Claude-SSE-focused subset sufficient for the synthetic
//     streams used in compact.json -- NOT a byte-for-byte port of the full
//     (Gemini/OpenAI-aware) original. `parseSSEData`,
//     `resolveAnthropicStreamActualResponseModel`, and
//     `extractThinkingSignatureModelFromStream` import cleanly and are used
//     for real.

import { EncodingFixer } from "../../src/app/v1/_lib/proxy/response-fixer/encoding-fixer";
import { SseFixer } from "../../src/app/v1/_lib/proxy/response-fixer/sse-fixer";
import { JsonFixer } from "../../src/app/v1/_lib/proxy/response-fixer/json-fixer";
import {
  createClientAbortMeteringObserver,
  type ClientAbortMeteringObserver,
} from "../../src/app/v1/_lib/proxy/client-abort-metering";
import { parseSSEData } from "../../src/lib/utils/sse";
import { resolveAnthropicStreamActualResponseModel } from "../../src/app/v1/_lib/proxy/anthropic-actual-response-model";

const OUT_DIR = "tests/fixtures/edge";
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function writeJSON(relPath: string, data: unknown): Promise<void> {
  const path = `${OUT_DIR}/${relPath}`;
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

// ---------------------------------------------------------------------------
// encoding.json
// ---------------------------------------------------------------------------

type EncodingCase = {
  name: string;
  inputB64: string;
  expectedDataB64: string;
  expectedApplied: boolean;
  expectedDetails: string | null;
};

function buildEncodingCases(): EncodingCase[] {
  const cases: EncodingCase[] = [];
  const run = (name: string, input: Uint8Array) => {
    const res = new EncodingFixer().fix(input);
    cases.push({
      name,
      inputB64: b64(input),
      expectedDataB64: b64(res.data),
      expectedApplied: res.applied,
      expectedDetails: res.details ?? null,
    });
  };

  run("valid_utf8_passthrough", enc.encode("Hello 世界"));
  run("utf8_bom_stripped", new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("Hello")]));
  run("utf16_bom_stripped", new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
  run("null_bytes_stripped", new Uint8Array([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]));
  run("invalid_utf8_lossy_fixed", new Uint8Array([0xc3, 0x28, 0x61]));

  // Extra WHATWG-decoder edge cases (maximal-subpart replacement semantics).
  run("overlong_lead_then_valid_continuation", new Uint8Array([0xe0, 0x80, 0x80, 0x61])); // overlong encoding
  run("truncated_multibyte_at_end", new Uint8Array([0x61, 0xe2, 0x82])); // "a" + incomplete 3-byte seq
  run("lone_continuation_byte", new Uint8Array([0x61, 0x80, 0x62])); // "a" + stray continuation + "b"
  run("surrogate_range_rejected", new Uint8Array([0xed, 0xa0, 0x80])); // encodes U+D800 (surrogate), invalid in UTF-8
  run("f4_upper_boundary", new Uint8Array([0xf4, 0x90, 0x80, 0x80])); // > U+10FFFF, invalid continuation for F4
  run("empty_input", new Uint8Array([]));

  return cases;
}

// ---------------------------------------------------------------------------
// sse.json
// ---------------------------------------------------------------------------

type SseCase = {
  name: string;
  inputB64: string;
  expectedDataB64: string;
  expectedApplied: boolean;
};

function buildSseCases(): SseCase[] {
  const cases: SseCase[] = [];
  const run = (name: string, input: string) => {
    const res = new SseFixer().fix(enc.encode(input));
    cases.push({
      name,
      inputB64: b64(enc.encode(input)),
      expectedDataB64: b64(res.data),
      expectedApplied: res.applied,
    });
  };

  run("valid_sse_passthrough", 'data: {"test": true}\n');
  run("missing_space_after_data_colon", 'data:{"test": true}\n');
  run("long_data_line", `data:${"a".repeat(100_000)}\n`);
  run("bare_json_object_wrapped", '{"content": "hello"}\n');
  run("bare_json_array_wrapped", '[{"delta": {}}]\n');
  run("done_sentinel_wrapped", "[DONE]\n");
  run("comment_line_preserved", ": this is a comment\ndata: test\n");
  run("event_field_space_fixed", "event:message\ndata: test\n");
  run("id_field_space_fixed", "id:123\ndata: test\n");
  run("retry_field_space_fixed", "retry:1000\ndata: test\n");
  run("crlf_normalized", "data: test\r\ndata: test2\r\n");
  run("cr_only_normalized", "data: test\rdata: test2\r");
  run("data_capitalized_fixed", 'Data:{"test": true}\n');
  run("data_upper_fixed", 'DATA:{"test": true}\n');
  run("data_space_before_colon_fixed", 'data :{"test": true}\n');
  run("consecutive_blank_lines_collapsed", "data: test\n\n\n\ndata: test2\n");
  run("multiline_data_preserved", "data: line1\ndata: line2\n\n");

  return cases;
}

// ---------------------------------------------------------------------------
// json.json
// ---------------------------------------------------------------------------

type JsonCase = {
  name: string;
  inputB64: string;
  maxDepth: number;
  maxSize: number;
  expectedApplied: boolean;
  expectedDetails: string | null;
  // The repaired bytes are only meaningfully comparable via re-parse (the
  // TS tests only assert JSON.parse succeeds / matches an object), so we
  // record the parsed-back value (or null if parsing should fail / applied
  // is false and we just compare raw bytes).
  expectedDataB64: string;
  expectAppliedDataParsesTo?: unknown;
};

function buildJsonCases(): JsonCase[] {
  const cases: JsonCase[] = [];
  const run = (
    name: string,
    input: string,
    maxDepth: number,
    maxSize: number,
    expectAppliedDataParsesTo?: unknown
  ) => {
    const fixer = new JsonFixer({ maxDepth, maxSize });
    const res = fixer.fix(enc.encode(input));
    cases.push({
      name,
      inputB64: b64(enc.encode(input)),
      maxDepth,
      maxSize,
      expectedApplied: res.applied,
      expectedDetails: res.details ?? null,
      expectedDataB64: b64(res.data),
      expectAppliedDataParsesTo,
    });
  };

  run("valid_json_passthrough", '{"a":1}', 200, 1024 * 1024);
  run("unclosed_object", '{"key":"value"', 200, 1024 * 1024, { key: "value" });
  run("unclosed_array", "[1, 2, 3", 200, 1024 * 1024, [1, 2, 3]);
  run("unclosed_string", '{"key":"val', 200, 1024 * 1024, { key: "val" });
  run("trailing_comma_object", '{"a": 1,}', 200, 1024 * 1024, { a: 1 });
  run("trailing_comma_array", "[1, 2,]", 200, 1024 * 1024, [1, 2]);
  run("missing_value_after_colon", '{"key":', 200, 1024 * 1024, { key: null });
  run("nested_unclosed", '{"outer": {"inner": [1, 2', 200, 1024 * 1024, {
    outer: { inner: [1, 2] },
  });
  run("exceeds_max_depth_unchanged", '{"a":{"b":{"c":{"d":', 3, 1024 * 1024);
  run("exceeds_max_size_unchanged", '{"key":"very long value"}', 200, 10);

  return cases;
}

// ---------------------------------------------------------------------------
// nonstream.json -- FixNonStream(body, cfg): encoding -> json, whole body.
// ---------------------------------------------------------------------------

type NonStreamCase = {
  name: string;
  inputB64: string;
  cfg: { fixEncoding: boolean; fixTruncatedJson: boolean; maxJsonDepth: number; maxFixSize: number };
  expectedEncodingApplied: boolean;
  expectedJsonApplied: boolean;
  expectedHit: boolean;
  expectedDataParsesAsJson: boolean;
  expectedDataB64ForNonJsonCase: string | null;
};

function buildNonStreamCases(): NonStreamCase[] {
  const cfg = { fixEncoding: true, fixTruncatedJson: true, maxJsonDepth: 200, maxFixSize: 1024 * 1024 };

  const run = (name: string, input: Uint8Array): NonStreamCase => {
    let data: Uint8Array = input;
    let encodingApplied = false;
    let jsonApplied = false;

    const encRes = new EncodingFixer().fix(data);
    if (encRes.applied) {
      encodingApplied = true;
      data = encRes.data;
    }
    const jsonFixer = new JsonFixer({ maxDepth: cfg.maxJsonDepth, maxSize: cfg.maxFixSize });
    const jsonRes = jsonFixer.fix(data);
    if (jsonRes.applied) {
      jsonApplied = true;
      data = jsonRes.data;
    }

    let parsesAsJson = false;
    try {
      JSON.parse(dec.decode(data));
      parsesAsJson = true;
    } catch {
      parsesAsJson = false;
    }

    return {
      name,
      inputB64: b64(input),
      cfg,
      expectedEncodingApplied: encodingApplied,
      expectedJsonApplied: jsonApplied,
      expectedHit: encodingApplied || jsonApplied,
      expectedDataParsesAsJson: parsesAsJson,
      expectedDataB64ForNonJsonCase: parsesAsJson ? null : b64(data),
    };
  };

  return [
    run("valid_json_body", enc.encode('{"ok":true}')),
    run("truncated_json_with_bom", new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('{"a":1,"b":')])),
    run(
      "invalid_utf8_and_truncated",
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28]) // {"a":"<invalid>
    ),
    run("not_json_passthrough", enc.encode("plain text body")),
  ];
}

// ---------------------------------------------------------------------------
// stream.json -- drives EncodingFixer -> SseFixer -> per-line JsonFixer
// through a reimplementation of index.ts's ChunkBuffer buffering, split
// across several chunk patterns. (See header comment: driving the real
// ResponseFixer.processStream would require a ProxySession/session-manager/
// DB stub; this replicates the equivalent fixer sequence using the real
// fixer classes plus a from-spec reimplementation of ChunkBuffer.)
// ---------------------------------------------------------------------------

const LF = 0x0a;
const CR = 0x0d;

class ChunkBufferSim {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private headOffset = 0;
  private total = 0;
  private processableEnd = 0;
  private pendingCR = false;

  get length(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const prevTotal = this.total;
    this.chunks.push(chunk);
    this.total += chunk.length;

    if (this.pendingCR) {
      this.processableEnd = chunk[0] === LF ? prevTotal + 1 : prevTotal;
      this.pendingCR = false;
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b === LF) {
        this.processableEnd = prevTotal + i + 1;
        continue;
      }
      if (b !== CR) continue;
      if (i + 1 < chunk.length) {
        if (chunk[i + 1] !== LF) this.processableEnd = prevTotal + i + 1;
        continue;
      }
      this.pendingCR = true;
    }
  }

  findProcessableEnd(): number {
    if (this.total === 0) return 0;
    if (this.pendingCR) return 0;
    return this.processableEnd;
  }

  take(size: number): Uint8Array {
    if (size <= 0) return new Uint8Array(0);
    const out = new Uint8Array(size);
    let outOffset = 0;
    while (outOffset < size) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      const toCopy = Math.min(available, size - outOffset);
      out.set(chunk.subarray(this.headOffset, this.headOffset + toCopy), outOffset);
      outOffset += toCopy;
      this.headOffset += toCopy;
      this.total -= toCopy;
      if (this.headOffset >= chunk.length) {
        this.head += 1;
        this.headOffset = 0;
      }
    }
    if (this.head > 64) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
    this.processableEnd = Math.max(0, this.processableEnd - size);
    return out;
  }

  drain(): Uint8Array {
    const out = this.take(this.total);
    this.chunks = [];
    this.head = 0;
    this.headOffset = 0;
    this.total = 0;
    this.processableEnd = 0;
    this.pendingCR = false;
    return out;
  }
}

const SSE_DATA_PREFIX_WITH_SPACE = enc.encode("data: ");

function fixMaybeDataJsonLine(
  line: Uint8Array,
  jsonFixer: JsonFixer
): { line: Uint8Array; applied: boolean } {
  const prefix = enc.encode("data:");
  if (line.length < prefix.length) return { line, applied: false };
  for (let i = 0; i < prefix.length; i += 1) {
    if (line[i] !== prefix[i]) return { line, applied: false };
  }
  let payloadStart = prefix.length;
  if (payloadStart < line.length && line[payloadStart] === 0x20) payloadStart += 1;
  const payload = line.subarray(payloadStart);
  const res = jsonFixer.fix(payload);
  if (!res.applied) return { line, applied: false };
  const out = new Uint8Array(SSE_DATA_PREFIX_WITH_SPACE.length + res.data.length);
  out.set(SSE_DATA_PREFIX_WITH_SPACE, 0);
  out.set(res.data, SSE_DATA_PREFIX_WITH_SPACE.length);
  return { line: out, applied: true };
}

function fixSseJsonLines(data: Uint8Array, jsonFixer: JsonFixer): Uint8Array {
  let lineStart = 0;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== LF) continue;
    const line = data.subarray(lineStart, i);
    const fixed = fixMaybeDataJsonLine(line, jsonFixer);
    parts.push(fixed.applied ? fixed.line : line);
    parts.push(new Uint8Array([LF]));
    lineStart = i + 1;
  }
  if (lineStart < data.length) {
    const line = data.subarray(lineStart);
    const fixed = fixMaybeDataJsonLine(line, jsonFixer);
    parts.push(fixed.applied ? fixed.line : line);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

type StreamFixtureConfig = {
  fixEncoding: boolean;
  fixSseFormat: boolean;
  fixTruncatedJson: boolean;
  maxJsonDepth: number;
  maxFixSize: number;
};

function runStreamPipeline(chunks: Uint8Array[], cfg: StreamFixtureConfig): Uint8Array {
  const encodingFixer = cfg.fixEncoding ? new EncodingFixer() : null;
  const sseFixer = cfg.fixSseFormat ? new SseFixer() : null;
  const jsonFixer = cfg.fixTruncatedJson ? new JsonFixer({ maxDepth: cfg.maxJsonDepth, maxSize: cfg.maxFixSize }) : null;

  const apply = (input: Uint8Array): Uint8Array => {
    let data = input;
    if (encodingFixer) {
      const res = encodingFixer.fix(data);
      if (res.applied) data = res.data;
    }
    if (sseFixer) {
      const res = sseFixer.fix(data);
      if (res.applied) data = res.data;
    }
    if (jsonFixer) {
      data = fixSseJsonLines(data, jsonFixer);
    }
    return data;
  };

  const buffer = new ChunkBufferSim();
  let passthrough = false;
  const outParts: Uint8Array[] = [];

  for (const chunk of chunks) {
    if (passthrough) {
      outParts.push(chunk);
      continue;
    }
    if (buffer.length + chunk.length > cfg.maxFixSize) {
      passthrough = true;
      outParts.push(buffer.drain());
      outParts.push(chunk);
      continue;
    }
    buffer.push(chunk);
    const end = buffer.findProcessableEnd();
    if (end <= 0) continue;
    outParts.push(apply(buffer.take(end)));
  }
  if (buffer.length > 0) {
    outParts.push(apply(buffer.drain()));
  }

  let total = 0;
  for (const p of outParts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of outParts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function splitBytes(data: Uint8Array, pattern: "single" | "byte" | number[]): Uint8Array[] {
  if (pattern === "single") return [data];
  if (pattern === "byte") return Array.from(data).map((b) => new Uint8Array([b]));
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const size of pattern) {
    if (offset >= data.length) break;
    out.push(data.subarray(offset, Math.min(offset + size, data.length)));
    offset += size;
  }
  if (offset < data.length) out.push(data.subarray(offset));
  return out;
}

type StreamCase = {
  name: string;
  fullInputB64: string;
  splitPattern: string;
  chunksB64: string[];
  cfg: StreamFixtureConfig;
  expectedOutputB64: string;
};

function buildStreamCases(): StreamCase[] {
  const cfg: StreamFixtureConfig = {
    fixEncoding: true,
    fixSseFormat: true,
    fixTruncatedJson: true,
    maxJsonDepth: 200,
    maxFixSize: 1024 * 1024,
  };

  const sseText =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x"}}\n\n' +
    'event: content_block_delta\ndata:{"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"\n\n'; // truncated json on purpose

  const utf8Payload = "Hello 世界 😀"; // includes emoji (surrogate pair in UTF-16, 4-byte UTF-8)
  const mixedText = `data: {"content":"${utf8Payload}"}\n\n`;

  // Bytes with an invalid UTF-8 sequence embedded mid-stream, and a BOM at
  // the very start (covers "split mid multi-byte sequence").
  const invalidUtf8Bytes = new Uint8Array([
    ...enc.encode("data: {\"a\":\""),
    0xc3,
    0x28, // invalid 2-byte lead
    ...enc.encode('"}\n\n'),
  ]);

  const cases: StreamCase[] = [];
  const add = (name: string, full: Uint8Array, splitPattern: string, chunks: Uint8Array[]) => {
    const expected = runStreamPipeline(chunks, cfg);
    cases.push({
      name,
      fullInputB64: b64(full),
      splitPattern,
      chunksB64: chunks.map(b64),
      cfg,
      expectedOutputB64: b64(expected),
    });
  };

  {
    const full = enc.encode(sseText);
    add("sse_single_chunk", full, "single", splitBytes(full, "single"));
    add("sse_byte_at_a_time", full, "byte", splitBytes(full, "byte"));
    add("sse_split_mid_line", full, "custom_mid_line", splitBytes(full, [10, 25, 9999]));
    add("sse_split_arbitrary_sizes", full, "custom_arbitrary", splitBytes(full, [3, 7, 13, 21, 5, 9999]));
  }
  {
    const full = enc.encode(mixedText);
    // Split precisely inside the 4-byte emoji UTF-8 sequence.
    const emojiByteOffset = enc.encode('data: {"content":"Hello 世界 "').length;
    add(
      "utf8_split_mid_multibyte",
      full,
      "custom_mid_utf8",
      splitBytes(full, [emojiByteOffset + 1, 9999])
    );
    add("utf8_split_mid_multibyte_2", full, "custom_mid_utf8_2", splitBytes(full, [emojiByteOffset + 2, 9999]));
  }
  {
    add("invalid_utf8_split", invalidUtf8Bytes, "custom_invalid_utf8", splitBytes(invalidUtf8Bytes, [14, 9999]));
  }
  {
    // CRLF split exactly at the CR/LF boundary across chunks.
    const full = enc.encode('data: test\r\ndata: test2\r\n');
    add("crlf_split_at_boundary", full, "custom_crlf", splitBytes(full, [11, 9999]));
  }

  return cases;
}

// ---------------------------------------------------------------------------
// metering.json -- 18 scenarios ported from client-abort-metering.test.ts
// ---------------------------------------------------------------------------

type ObserveCall = {
  chunkB64: string;
  errorSeen: boolean;
  drainComplete: boolean;
};

type MeteringCase = {
  name: string;
  format: string;
  attachedMaxFrameBytes: number | null;
  // Sequence of actions: either an "observe" (with the chunk + expected
  // return) or a "detach" marker.
  actions: Array<{ kind: "observe"; chunkB64: string; errorSeen: boolean; drainComplete: boolean } | { kind: "detach" }>;
  finish: {
    text: string;
    sawContent: boolean;
    terminalSeen: boolean;
    incompleteSeen: boolean;
    retainedBytes: number;
    skippedOversizedFrames: number;
    protocolFailure: { afterContent: boolean; verdict: string; eventName: string | null } | null;
  };
  // For the one test that calls finish() twice, the second snapshot.
  finishAgain?: MeteringCase["finish"];
}[];

function buildMeteringCases() {
  const cases: Array<{
    name: string;
    format: string;
    attachedMaxFrameBytes: number | null;
    actions: Array<
      | { kind: "observe"; chunkB64: string; errorSeen: boolean; drainComplete: boolean }
      | { kind: "detach" }
    >;
    finishAfterActions: number;
    finish: {
      text: string;
      sawContent: boolean;
      terminalSeen: boolean;
      incompleteSeen: boolean;
      retainedBytes: number;
      skippedOversizedFrames: number;
      protocolFailure: { afterContent: boolean; verdict: string; eventName: string | null } | null;
    };
    finishAgain?: {
      text: string;
      sawContent: boolean;
      terminalSeen: boolean;
      incompleteSeen: boolean;
      retainedBytes: number;
      skippedOversizedFrames: number;
      protocolFailure: { afterContent: boolean; verdict: string; eventName: string | null } | null;
    };
  }> = [];

  function makeObserver(format: string, attachedMaxFrameBytes: number | null): ClientAbortMeteringObserver {
    return attachedMaxFrameBytes != null
      ? createClientAbortMeteringObserver(format as any, { attachedMaxFrameBytes })
      : createClientAbortMeteringObserver(format as any);
  }

  function snapshotOf(observer: ClientAbortMeteringObserver) {
    const s = observer.finish();
    return {
      text: s.text,
      sawContent: s.sawContent,
      terminalSeen: s.terminalSeen,
      incompleteSeen: s.incompleteSeen,
      retainedBytes: s.retainedBytes,
      skippedOversizedFrames: s.skippedOversizedFrames,
      protocolFailure: s.protocolFailure
        ? {
            afterContent: s.protocolFailure.afterContent,
            verdict: s.protocolFailure.verdict,
            eventName: s.protocolFailure.eventName,
          }
        : null,
    };
  }

  function run(
    name: string,
    format: string,
    attachedMaxFrameBytes: number | null,
    steps: Array<{ chunk: Uint8Array } | { detach: true } | { finishAndContinue: true }>
  ) {
    const observer = makeObserver(format, attachedMaxFrameBytes);
    const actions: Array<
      | { kind: "observe"; chunkB64: string; errorSeen: boolean; drainComplete: boolean }
      | { kind: "detach" }
    > = [];
    let finishAgain: MeteringCase[number]["finish"] | undefined;

    for (const step of steps) {
      if ("detach" in step) {
        observer.switchToDetachedMode();
        actions.push({ kind: "detach" });
        continue;
      }
      if ("finishAndContinue" in step) {
        // handled by caller after loop via extra observe calls post-finish
        continue;
      }
      const result = observer.observe(step.chunk);
      actions.push({
        kind: "observe",
        chunkB64: b64(step.chunk),
        errorSeen: result.errorSeen,
        drainComplete: result.drainComplete,
      });
    }

    const finish = snapshotOf(observer);
    cases.push({
      name,
      format,
      attachedMaxFrameBytes,
      actions,
      finishAfterActions: actions.length,
      finish,
      finishAgain,
    });
  }

  // 1. keeps only compact Responses accounting evidence
  run("responses_compact_accounting_evidence", "response", null, [
    {
      chunk: enc.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "x".repeat(32 * 1024),
        })}\n\n`
      ),
    },
    {
      chunk: enc.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            model: "gpt-test",
            output: [{ content: [{ text: "discard me" }] }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        })}\n\n`
      ),
    },
  ]);

  // 2. retains Claude initial and terminal usage until message_stop
  run("claude_initial_and_terminal_usage", "claude", null, [
    {
      chunk: enc.encode(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { model: "claude-test", usage: { input_tokens: 20, output_tokens: 1 } },
        })}\n\n`
      ),
    },
    {
      chunk: enc.encode(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 7 },
        })}\n\n`
      ),
    },
    { chunk: enc.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`) },
  ]);

  // 3. skips an oversized content frame and resumes at the next frame boundary
  run("skips_oversized_content_frame", "response", null, [
    {
      chunk: enc.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "x".repeat(70 * 1024),
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 5 } },
        })}\n\n`
      ),
    },
  ]);

  // 4. stops metering at an OpenAI done marker without requiring usage
  run("openai_done_marker", "openai", null, [{ chunk: enc.encode("data: [DONE]\n\n") }]);

  // 5. treats a valid Responses terminal without usage as complete
  run("responses_terminal_without_usage", "response", null, [
    {
      chunk: enc.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      ),
    },
  ]);

  // 6. does not treat standard nullable Responses error fields as protocol failures
  run("responses_nullable_error_not_failure", "response", null, [
    {
      chunk: enc.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","error":null,"usage":{"input_tokens":4,"output_tokens":2}}}\n\n'
      ),
    },
  ]);

  // 7. retains zero-valued usage without making it a completion requirement
  run("zero_valued_usage_retained", "response", null, [
    {
      chunk: enc.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
      ),
    },
  ]);

  // 8. does not treat initial Claude usage as a completed stream
  run("claude_initial_usage_not_terminal", "claude", null, [
    {
      chunk: enc.encode(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n'
      ),
    },
  ]);

  // 9. combines an OpenAI usage chunk with a later done marker across arbitrary splits
  {
    const text = `data: ${JSON.stringify({
      id: "chatcmpl_1",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = enc.encode(text);
    const steps: Array<{ chunk: Uint8Array }> = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      steps.push({ chunk: bytes.subarray(offset, offset + 7) });
    }
    run("openai_usage_then_done_across_splits", "openai", null, steps);
  }

  // 10. waits for OpenAI usage after finish_reason before ending the drain
  run("openai_waits_for_usage_after_finish_reason", "openai", null, [
    { chunk: enc.encode('data: {"choices":[{"finish_reason":"stop"}],"usage":null}\n\n') },
    {
      chunk: enc.encode(
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n'
      ),
    },
  ]);

  // 11. uses the last Gemini NDJSON usage and finishReason as terminal evidence
  run("gemini_last_ndjson_usage_and_finish", "gemini", null, [
    {
      chunk: enc.encode(
        `${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "discard" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
        })}\n`
      ),
    },
    {
      chunk: enc.encode(
        `${JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
        })}\n`
      ),
    },
  ]);

  // 12. retains compact protocol errors without retaining content
  run("compact_protocol_errors_no_content", "response", null, [
    {
      chunk: enc.encode(
        `event: error\ndata: ${JSON.stringify({
          type: "response.error",
          error: { code: "upstream_failed", message: "failure" },
          debug: "x".repeat(32 * 1024),
        })}\n\n`
      ),
    },
  ]);

  // 13. compacts extended usage, metadata, cache, and signature evidence
  run("compacts_extended_usage_metadata_signature", "response", null, [
    {
      chunk: enc.encode(
        `event: response.in_progress\ndata: ${JSON.stringify({
          id: "resp_extended",
          model: "gpt-extended",
          prompt_cache_key: "cache-key",
          service_tier: "priority",
          status: "in_progress",
          type: "response.in_progress",
          message: { id: "message-1", model: "gpt-message", usage: { input_tokens: 1 } },
          delta: {
            type: "signature_delta",
            stop_reason: "end_turn",
            signature: "signed-model",
            usage: { output_tokens: 2 },
          },
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 2,
            cache_creation_5m_input_tokens: 1,
            cache_creation_1h_input_tokens: 1,
            cache_read_input_tokens: 4,
            input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
            candidatesTokensDetails: [null, {}, { modality: "TEXT", tokenCount: 2 }, { tokenCount: 1 }],
            promptTokensDetails: [{ modality: "IMAGE", tokenCount: 3 }],
          },
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
          choices: [null, {}, { finish_reason: "stop" }],
          candidates: [null, {}, { finishReason: "STOP" }],
          ignored: "not retained",
        })}\n\n`
      ),
    },
    {
      chunk: enc.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_extended",
            model: "gpt-extended",
            service_tier: "priority",
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        })}\n\n`
      ),
    },
  ]);

  // 14. handles comments, multi-line data, bare JSON tails, and malformed frames
  run("comments_multiline_bare_json_malformed", "gemini-cli", null, [
    { chunk: new Uint8Array() },
    {
      chunk: enc.encode(
        ': keepalive\rretry: 1000\revent: message\rdata: {"usageMetadata":\rdata: {"promptTokenCount":10,"candidatesTokenCount":2}}\r\r'
      ),
    },
    { chunk: enc.encode("data: true\n\n") },
    { chunk: enc.encode("data: not-json\n\n") },
    { chunk: enc.encode("data: still-not-json\n\n") },
    {
      chunk: enc.encode(
        JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        })
      ),
    },
  ]);

  // 15. recovers after an oversized bare JSON line and ignores post-finish input
  //     (two finish() calls; the second must equal the first)
  {
    const observer = createClientAbortMeteringObserver("gemini" as any);
    const actions: MeteringCase[number]["actions"] = [];
    const obs = (chunk: Uint8Array) => {
      const r = observer.observe(chunk);
      actions.push({ kind: "observe", chunkB64: b64(chunk), errorSeen: r.errorSeen, drainComplete: r.drainComplete });
    };
    obs(enc.encode(`{"ignored":"${"x".repeat(70 * 1024)}"}\n`));
    obs(
      enc.encode(
        `${JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        })}`
      )
    );
    const first = snapshotOf(observer);
    const finishAfterActions = actions.length;
    obs(enc.encode('{"error":true}\n'));
    const second = snapshotOf(observer);
    cases.push({
      name: "recovers_after_oversized_bare_json_ignores_post_finish",
      format: "gemini",
      attachedMaxFrameBytes: null,
      actions,
      finishAfterActions,
      finish: first,
      finishAgain: second,
    });
  }

  // 16. does not fabricate completion from an oversized unvalidated terminal frame
  run("no_fabricated_completion_oversized_terminal", "response", null, [
    {
      chunk: enc.encode(
        'event: response.completed\ndata: {"type":"response.completed","padding":"' + "x".repeat(70 * 1024)
      ),
    },
    { chunk: enc.encode('"}\n\n') },
  ]);

  // 17. recovers at the next NDJSON line after tightening an in-flight frame
  run("recovers_at_next_ndjson_line_after_tightening", "gemini", 128 * 1024, [
    {
      chunk: enc.encode(`{"candidates":[{"content":{"parts":[{"text":"${"x".repeat(70 * 1024)}`),
    },
    { detach: true },
    {
      chunk: enc.encode(
        '"}]}}]}\n{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n'
      ),
    },
  ]);

  // 18/19. it.each -- Responses incomplete (event-named and bare-data variants)
  run("responses_incomplete_with_event_name", "response", null, [
    {
      chunk: enc.encode(
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'
      ),
    },
  ]);
  run("responses_incomplete_bare_data", "response", null, [
    {
      chunk: enc.encode('data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'),
    },
  ]);

  // 20. records protocol failure after content independently from completion
  run("protocol_failure_after_content", "response", null, [
    {
      chunk: enc.encode(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'
      ),
    },
    {
      chunk: enc.encode(
        'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'
      ),
    },
  ]);

  return cases;
}

// ---------------------------------------------------------------------------
// compact.json -- synthetic Anthropic SSE streams + independently-derived
// expected compact output, cross-checked against usage/model extraction.
// ---------------------------------------------------------------------------

// Minimal Claude-focused reimplementation of extractUsageMetrics (see file
// header: the real one lives in response-handler.ts, which cannot be
// imported standalone). Only handles the fields our synthetic fixtures use.
function extractUsageMetricsSimplified(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  let hasAny = false;
  for (const field of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_creation_5m_input_tokens",
    "cache_creation_1h_input_tokens",
    "cache_read_input_tokens",
  ]) {
    const v = usage[field];
    if (typeof v === "number") {
      result[field] = v;
      hasAny = true;
    }
  }
  return hasAny ? result : null;
}

// Minimal Claude-SSE-focused reimplementation of parseUsageFromResponseText's
// message_start/message_delta merge logic (see file header for why).
function parseUsageFromResponseTextSimplified(sseText: string): Record<string, number> | null {
  const events = parseSSEData(sseText);
  let messageStartUsage: Record<string, number> | null = null;
  let messageDeltaUsage: Record<string, number> | null = null;
  const merge = (base: Record<string, number> | null, patch: Record<string, number>) =>
    base ? { ...base, ...patch } : { ...patch };

  for (const event of events) {
    if (typeof event.data !== "object" || !event.data) continue;
    const data = event.data as Record<string, unknown>;
    if (event.event === "message_start") {
      let usageValue: unknown = null;
      if (data.message && typeof data.message === "object") {
        usageValue = (data.message as Record<string, unknown>).usage;
      }
      if (!usageValue) usageValue = data.usage;
      const extracted = extractUsageMetricsSimplified(usageValue);
      if (extracted) messageStartUsage = merge(messageStartUsage, extracted);
    }
    if (event.event === "message_delta") {
      let usageValue: unknown = data.usage;
      if (!usageValue && data.delta && typeof data.delta === "object") {
        usageValue = (data.delta as Record<string, unknown>).usage;
      }
      const extracted = extractUsageMetricsSimplified(usageValue);
      if (extracted) messageDeltaUsage = merge(messageDeltaUsage, extracted);
    }
  }

  if (messageDeltaUsage && messageStartUsage) return merge(messageStartUsage, messageDeltaUsage);
  return messageDeltaUsage ?? messageStartUsage;
}

// Independent (script-local) reimplementation of the compact-capture spec,
// used ONLY to derive the expected fixture output -- deliberately written
// without reference to the Go implementation, from the spec in the task
// description, so it serves as a genuine cross-check rather than an oracle
// copy.
function deriveExpectedCompact(
  fullSse: string,
  maxBytes: number
): { text: string; truncated: boolean; eventCount: number } {
  type Frame = { event: string | null; data: string };
  const frames: Frame[] = [];
  let curEvent: string | null = null;
  let curData: string[] = [];
  const flush = () => {
    if (curData.length === 0) {
      curEvent = null;
      return;
    }
    frames.push({ event: curEvent, data: curData.join("\n") });
    curEvent = null;
    curData = [];
  };
  for (const rawLine of fullSse.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      curEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      curData.push(v);
    }
  }
  flush();

  let messageStartKept = false;
  let messageStopKept = false;
  let signatureDeltaKept = 0;
  let out = "";
  let truncated = false;
  let overBudget = false;

  for (const frame of frames) {
    let name = frame.event ?? "";
    if (!name) {
      try {
        const parsed = JSON.parse(frame.data);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
          name = parsed.type;
        }
      } catch {
        // ignore
      }
    }

    let keep = false;
    let priority = false;
    if (name === "message_start" && !messageStartKept) {
      keep = true;
      messageStartKept = true;
    } else if (name === "message_delta") {
      keep = true;
      priority = true;
    } else if (name === "message_stop" && !messageStopKept) {
      keep = true;
      messageStopKept = true;
    } else if (name === "error") {
      keep = true;
      priority = true;
    } else if (name === "content_block_delta" && frame.data.includes("signature_delta") && signatureDeltaKept < 4) {
      keep = true;
      signatureDeltaKept += 1;
    }

    if (!keep) continue;
    const emitted = `event: ${name}\ndata: ${frame.data}\n\n`;

    if (!priority) {
      if (overBudget) continue;
      if (out.length + emitted.length > maxBytes) {
        overBudget = true;
        truncated = true;
        continue;
      }
      out += emitted;
      continue;
    }

    if (out.length + emitted.length > maxBytes) truncated = true;
    out += emitted;
  }

  return { text: out, truncated, eventCount: frames.length };
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type CompactStreamSpec = { name: string; maxBytes: number; full: string };

function buildCompactStreamSpecs(): CompactStreamSpec[] {
  const specs: CompactStreamSpec[] = [];

  // 1. text-only
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_1", model: "claude-text", usage: { input_tokens: 10, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } });
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "text_only", maxBytes: 64 * 1024, full: s });
  }

  // 2. thinking with signature_delta
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_2", model: "claude-think", usage: { input_tokens: 20, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-aaaa" } });
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } });
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 1 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "thinking_with_signature", maxBytes: 64 * 1024, full: s });
  }

  // 3. tool_use
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_3", model: "claude-tool", usage: { input_tokens: 15, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"SF"}' } });
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "tool_use", maxBytes: 64 * 1024, full: s });
  }

  // 4. ping-heavy
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_4", model: "claude-ping", usage: { input_tokens: 5, output_tokens: 1 } },
    });
    for (let i = 0; i < 20; i += 1) s += sseFrame("ping", { type: "ping" });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "ping_heavy", maxBytes: 64 * 1024, full: s });
  }

  // 5. error mid-stream
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_5", model: "claude-err", usage: { input_tokens: 8, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
    s += sseFrame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    specs.push({ name: "error_mid_stream", maxBytes: 64 * 1024, full: s });
  }

  // 6. many signature_delta frames (verify cap of 4)
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_6", model: "claude-sig-many", usage: { input_tokens: 9, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    for (let i = 0; i < 7; i += 1) {
      s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${i}` } });
    }
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 11 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "many_signature_deltas_capped", maxBytes: 64 * 1024, full: s });
  }

  // 7. tight byte budget forcing truncation of non-priority frames but
  //    still keeping message_delta.
  {
    let s = sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_7", model: "claude-tight", usage: { input_tokens: 30, output_tokens: 1 } },
    });
    s += sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < 5; i += 1) {
      s += sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "chunk of filler text ".repeat(20) } });
    }
    s += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 99 } });
    s += sseFrame("message_stop", { type: "message_stop" });
    specs.push({ name: "tight_budget_still_keeps_message_delta", maxBytes: 200, full: s });
  }

  return specs;
}

type CompactCase = {
  name: string;
  maxBytes: number;
  fullSseB64: string;
  expectedText: string;
  expectedTruncated: boolean;
  expectedEventCount: number;
  fullUsage: Record<string, number> | null;
  compactUsage: Record<string, number> | null;
  usageMatches: boolean;
  fullActualModel: { actualResponseModel: string | null; source: string | null };
  compactActualModel: { actualResponseModel: string | null; source: string | null };
  actualModelMatches: boolean;
};

function buildCompactCases(): CompactCase[] {
  const specs = buildCompactStreamSpecs();
  const cases: CompactCase[] = [];

  for (const spec of specs) {
    const derived = deriveExpectedCompact(spec.full, spec.maxBytes);

    const fullUsage = parseUsageFromResponseTextSimplified(spec.full);
    const compactUsage = parseUsageFromResponseTextSimplified(derived.text);
    const usageMatches = JSON.stringify(fullUsage) === JSON.stringify(compactUsage);

    const resolveParams = {
      providerType: "claude" as const,
      requestedModel: "claude-3-5-sonnet-20241022",
      thinkingEnabled: spec.full.includes("signature_delta"),
    };
    const fullModel = resolveAnthropicStreamActualResponseModel({
      ...resolveParams,
      responseStreamText: spec.full,
    });
    const compactModel = resolveAnthropicStreamActualResponseModel({
      ...resolveParams,
      responseStreamText: derived.text,
    });
    const actualModelMatches =
      fullModel.actualResponseModel === compactModel.actualResponseModel &&
      fullModel.source === compactModel.source;

    cases.push({
      name: spec.name,
      maxBytes: spec.maxBytes,
      fullSseB64: b64(enc.encode(spec.full)),
      expectedText: derived.text,
      expectedTruncated: derived.truncated,
      expectedEventCount: derived.eventCount,
      fullUsage,
      compactUsage,
      usageMatches,
      fullActualModel: fullModel,
      compactActualModel: compactModel,
      actualModelMatches,
    });

    if (!usageMatches) {
      throw new Error(`compact fixture "${spec.name}": usage mismatch between full and compact stream`);
    }
    if (!actualModelMatches) {
      throw new Error(`compact fixture "${spec.name}": actual-response-model mismatch between full and compact stream`);
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------

async function main() {
  await writeJSON("fixer/encoding.json", buildEncodingCases());
  await writeJSON("fixer/sse.json", buildSseCases());
  await writeJSON("fixer/json.json", buildJsonCases());
  await writeJSON("fixer/nonstream.json", buildNonStreamCases());
  await writeJSON("fixer/stream.json", buildStreamCases());
  await writeJSON("capture/metering.json", buildMeteringCases());
  await writeJSON("capture/compact.json", buildCompactCases());
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
