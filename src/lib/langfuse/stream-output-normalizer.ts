import { isSSEText, parseSSEData } from "@/lib/utils/sse";
import type { ParsedSSEEvent } from "@/types/message";

export type LangfuseStreamFamily = "responses" | "anthropic" | "openai-chat" | "gemini";

export type StreamingFamily = "responses-codex" | "anthropic" | "openai-chat" | "gemini";

export interface NormalizeLangfuseStreamingOutputInput {
  body: string;
  family: LangfuseStreamFamily;
}

export type NormalizedLangfuseOutput = Record<string, unknown>;

type IndexedBlocks = Map<number, AnthropicContentBlock>;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  inputJsonBuffer?: string[];
}

interface OpenAIChoiceBuilder {
  index: number;
  role: string | undefined;
  content: string;
  finishReason: string | null;
}

const RESPONSES_TERMINAL_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

/**
 * Normalizes a raw streaming-response body into a single trustworthy merged
 * structured final object suitable for Langfuse trace output. Returns null
 * when the body does not contain a trustworthy terminal signal — callers
 * must then fall back to the existing raw/error trace behavior.
 *
 * Contract: this function MUST NOT fabricate a completed structured object
 * for streams that did not reach a terminal payload. Incomplete streams,
 * unknown families, and family/body mismatches all yield null.
 */
export function normalizeLangfuseStreamingOutput(
  input: NormalizeLangfuseStreamingOutputInput
): NormalizedLangfuseOutput | null {
  const { body, family } = input;
  if (!body || !body.trim()) {
    return null;
  }

  // NDJSON Gemini streams are not SSE; SSE families go through parseSSEData.
  // Gemini may also arrive as data: only (handled by parseSSEData) — fall
  // through to family handlers for both shapes.
  if (isSSEText(body)) {
    const events = parseSSEData(body);
    const result = normalizeByFamily(events, family);
    return result;
  }

  // NDJSON (newline-delimited JSON, no SSE framing) — used by some Gemini
  // passthrough branches and raw OpenAI streaming.
  const parsed = parseNdjson(body);
  if (parsed.length > 0) {
    return normalizeNdjsonByFamily(parsed, family);
  }

  return null;
}

/**
 * Positional spec-facing adapter for `normalizeLangfuseStreamingOutput`.
 * Accepts the spec's `StreamingFamily` (`"responses-codex"` maps to the
 * internal `"responses"` family) and returns the merged structured object
 * or null/undefined to force legacy fallback.
 */
export function normalizeStreamOutput(body: string, family: StreamingFamily): unknown | null {
  const internalFamily: LangfuseStreamFamily = family === "responses-codex" ? "responses" : family;
  return normalizeLangfuseStreamingOutput({ body, family: internalFamily });
}

function normalizeByFamily(
  events: ParsedSSEEvent[],
  family: LangfuseStreamFamily
): NormalizedLangfuseOutput | null {
  switch (family) {
    case "responses":
      return normalizeResponses(events);
    case "anthropic":
      return normalizeAnthropic(events);
    case "openai-chat":
      return normalizeOpenAIChat(events);
    case "gemini":
      return normalizeGeminiFromEvents(events);
    default:
      return null;
  }
}

function normalizeNdjsonByFamily(
  objects: unknown[],
  family: LangfuseStreamFamily
): NormalizedLangfuseOutput | null {
  switch (family) {
    case "gemini":
      return normalizeGeminiFromObjects(objects);
    case "openai-chat":
      return normalizeOpenAIChatFromObjects(objects);
    case "responses":
      return normalizeResponsesFromObjects(objects);
    case "anthropic":
      return null;
    default:
      return null;
  }
}

function parseNdjson(body: string): unknown[] {
  const out: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON lines
    }
  }
  return out;
}

function asObject(value: ParsedSSEEvent["data"]): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// ---------- Responses / Codex ----------

function normalizeResponses(events: ParsedSSEEvent[]): NormalizedLangfuseOutput | null {
  const typed = events
    .map((e) => asObject(e.data))
    .filter((obj): obj is Record<string, unknown> => obj !== null);

  // Terminal-object-first: a response.completed event carrying a response
  // with status "completed" AND a non-empty output array wins verbatim.
  // A completed event whose response lacks output falls through to the
  // synthesis path, where the terminal response provides base metadata and
  // the done/delta events provide the actual content.
  let terminalResponseForBase: Record<string, unknown> | null = null;
  for (let i = typed.length - 1; i >= 0; i -= 1) {
    const obj = typed[i];
    const type = obj.type;
    if (typeof type !== "string" || !RESPONSES_TERMINAL_TYPES.has(type)) {
      continue;
    }
    const response = obj.response;
    if (type === "response.completed" && isPlainObject(response)) {
      const status = (response as Record<string, unknown>).status;
      if (status === "completed") {
        const output = (response as Record<string, unknown>).output;
        if (Array.isArray(output) && output.length > 0) {
          return { ...(response as Record<string, unknown>) };
        }
        // Completed status but no output -> synthesize, using this response
        // as the base instead of (or in addition to) response.created.
        terminalResponseForBase = response as Record<string, unknown>;
        break;
      }
      // completed event but non-completed status -> not a terminal signal.
      continue;
    }
    // response.failed / response.incomplete -> refuse normalization.
    return null;
  }

  // Synthesis path: need id/model/created (from response.created) plus
  // either output_text.done text or output_text.delta concatenation.
  let created: Record<string, unknown> | null = null;
  let doneText: string | null = null;
  let reasoningDoneText: string | null = null;
  const deltaParts: string[] = [];

  for (const obj of typed) {
    const type = obj.type;
    if (type === "response.created" && isPlainObject(obj.response)) {
      created = obj.response as Record<string, unknown>;
    } else if (type === "response.output_text.done" && typeof obj.text === "string") {
      doneText = obj.text;
    } else if (type === "response.reasoning_summary_text.done" && typeof obj.text === "string") {
      reasoningDoneText = obj.text;
    } else if (
      type === "response.reasoning_summary_part.done" &&
      isPlainObject(obj.part) &&
      typeof (obj.part as Record<string, unknown>).text === "string"
    ) {
      reasoningDoneText = (obj.part as Record<string, unknown>).text as string;
    } else if (type === "response.output_text.delta" && typeof obj.delta === "string") {
      deltaParts.push(obj.delta);
    }
  }

  if (!created) {
    // Without a base ResponseObject we cannot synthesize a trustworthy object.
    return null;
  }

  const text = doneText ?? (deltaParts.length > 0 ? deltaParts.join("") : null);
  if (text === null) {
    // No usable output text — refuse to fabricate.
    return null;
  }

  // Terminal response (response.completed without output) may still carry
  // authoritative usage metadata — prefer it over fabricated zeros.
  const terminalUsage = isPlainObject(terminalResponseForBase?.usage)
    ? { ...(terminalResponseForBase.usage as Record<string, unknown>) }
    : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  const synthesized: NormalizedLangfuseOutput = {
    id: created.id,
    object: "response",
    created: created.created,
    model: created.model,
    status: "completed",
    output: [
      {
        id: `${created.id ?? "resp"}_message`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: terminalUsage,
  };

  // Optional reasoning summary block (text-only synthesis).
  if (reasoningDoneText !== null) {
    (synthesized.output as unknown[]).unshift({
      id: `${created.id ?? "resp"}_reasoning`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoningDoneText }],
    });
  }

  return synthesized;
}

function normalizeResponsesFromObjects(objects: unknown[]): NormalizedLangfuseOutput | null {
  // Responses SSE events are not NDJSON; reject.
  void objects;
  return null;
}

// ---------- Anthropic ----------

function normalizeAnthropic(events: ParsedSSEEvent[]): NormalizedLangfuseOutput | null {
  let base: Record<string, unknown> | null = null;
  const blocks: IndexedBlocks = new Map();
  let stopReason: unknown;
  let stopSequence: unknown;
  let messageDeltaUsage: Record<string, unknown> | null = null;
  let sawMessageStop = false;

  for (const evt of events) {
    const obj = asObject(evt.data);
    if (!obj) continue;
    const type = obj.type;

    if (type === "message_start" && isPlainObject(obj.message)) {
      base = { ...(obj.message as Record<string, unknown>) };
    } else if (type === "content_block_start" && typeof obj.index === "number") {
      const block = obj.content_block;
      if (isPlainObject(block)) {
        const b = block as Record<string, unknown>;
        blocks.set(obj.index, {
          type: typeof b.type === "string" ? b.type : "text",
          text: typeof b.text === "string" ? b.text : "",
          id: typeof b.id === "string" ? b.id : undefined,
          name: typeof b.name === "string" ? b.name : undefined,
          input: b.input,
          inputJsonBuffer: [],
        });
      }
    } else if (type === "content_block_delta" && typeof obj.index === "number") {
      const delta = obj.delta;
      if (!isPlainObject(delta)) continue;
      const d = delta as Record<string, unknown>;
      const block = blocks.get(obj.index) ?? {
        type: "text",
        text: "",
      };
      if (d.type === "text_delta" && typeof d.text === "string") {
        block.text = (block.text ?? "") + d.text;
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        if (!block.inputJsonBuffer) block.inputJsonBuffer = [];
        block.inputJsonBuffer.push(d.partial_json);
      }
      blocks.set(obj.index, block);
    } else if (type === "message_delta" && isPlainObject(obj.delta)) {
      const d = obj.delta as Record<string, unknown>;
      if (typeof d.stop_reason !== "undefined") {
        stopReason = d.stop_reason;
      }
      if (typeof d.stop_sequence !== "undefined") {
        stopSequence = d.stop_sequence;
      }
      if (isPlainObject(obj.usage)) {
        messageDeltaUsage = obj.usage as Record<string, unknown>;
      }
    } else if (type === "message_stop") {
      sawMessageStop = true;
    }
  }

  if (!base || !sawMessageStop) {
    // No trustworthy terminal signal — refuse.
    return null;
  }

  const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);
  const content: Record<string, unknown>[] = [];
  for (const idx of sortedIndices) {
    const block = blocks.get(idx);
    if (!block) continue;
    if (block.type === "tool_use") {
      let parsedInput: unknown = block.input ?? {};
      const buffer = block.inputJsonBuffer;
      if (buffer && buffer.length > 0) {
        try {
          parsedInput = JSON.parse(buffer.join(""));
        } catch {
          parsedInput = {};
        }
      }
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: parsedInput,
      });
    } else {
      content.push({
        type: block.type ?? "text",
        text: block.text ?? "",
      });
    }
  }

  const baseUsage = base.usage;
  const mergedUsage = mergeAnthropicUsage(baseUsage, messageDeltaUsage);

  return {
    ...base,
    content,
    stop_reason: stopReason ?? base.stop_reason ?? null,
    stop_sequence: stopSequence ?? base.stop_sequence ?? null,
    usage: mergedUsage,
  };
}

function mergeAnthropicUsage(
  base: unknown,
  delta: Record<string, unknown> | null
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (isPlainObject(base)) {
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) {
      result[k] = v;
    }
  }
  if (delta) {
    for (const [k, v] of Object.entries(delta)) {
      result[k] = v;
    }
  }
  return result;
}

// ---------- OpenAI Chat ----------

function normalizeOpenAIChat(events: ParsedSSEEvent[]): NormalizedLangfuseOutput | null {
  const objects = events
    .map((e) => asObject(e.data))
    .filter((obj): obj is Record<string, unknown> => obj !== null);
  return normalizeOpenAIChatFromObjects(objects);
}

function normalizeOpenAIChatFromObjects(objects: unknown[]): NormalizedLangfuseOutput | null {
  const typed = objects.filter((obj): obj is Record<string, unknown> => isPlainObject(obj));

  if (typed.length === 0) {
    return null;
  }

  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let systemFingerprint: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const choicesByIndex: Map<number, OpenAIChoiceBuilder> = new Map();
  let sawFinishReason = false;

  for (const obj of typed) {
    if (typeof obj.id === "string") id = obj.id;
    if (typeof obj.created === "number") created = obj.created;
    if (typeof obj.model === "string") model = obj.model;
    if (typeof obj.system_fingerprint === "string") {
      systemFingerprint = obj.system_fingerprint;
    }
    if (isPlainObject(obj.usage)) {
      usage = { ...(obj.usage as Record<string, unknown>) };
    }

    const choices = obj.choices;
    if (!Array.isArray(choices)) continue;

    for (const choice of choices) {
      if (!isPlainObject(choice)) continue;
      const c = choice as Record<string, unknown>;
      const index = typeof c.index === "number" ? c.index : 0;
      const builder = choicesByIndex.get(index) ?? {
        index,
        role: undefined,
        content: "",
        finishReason: null,
      };

      const delta = isPlainObject(c.delta) ? (c.delta as Record<string, unknown>) : null;
      if (delta) {
        if (typeof delta.role === "string" && !builder.role) {
          builder.role = delta.role;
        }
        if (typeof delta.content === "string") {
          builder.content += delta.content;
        }
      }
      if (typeof c.finish_reason === "string") {
        builder.finishReason = c.finish_reason;
        sawFinishReason = true;
      }
      choicesByIndex.set(index, builder);
    }
  }

  if (!sawFinishReason) {
    // No terminal choice state — refuse.
    return null;
  }

  const sortedChoices = [...choicesByIndex.values()].sort((a, b) => a.index - b.index);
  const choices = sortedChoices.map((b) => ({
    index: b.index,
    message: {
      role: b.role ?? "assistant",
      content: b.content,
    },
    finish_reason: b.finishReason,
    logprobs: null,
  }));

  const result: NormalizedLangfuseOutput = {
    id: id ?? "",
    object: "chat.completion",
    created: created ?? 0,
    model: model ?? "",
    choices,
  };
  if (systemFingerprint !== undefined) {
    result.system_fingerprint = systemFingerprint;
  }
  if (usage) {
    result.usage = usage;
  }
  return result;
}

// ---------- Gemini ----------

function normalizeGeminiFromEvents(events: ParsedSSEEvent[]): NormalizedLangfuseOutput | null {
  const objects = events
    .map((e) => asObject(e.data))
    .filter((obj): obj is Record<string, unknown> => obj !== null);
  return normalizeGeminiFromObjects(objects);
}

function normalizeGeminiFromObjects(objects: unknown[]): NormalizedLangfuseOutput | null {
  const typed = objects.filter((obj): obj is Record<string, unknown> => isPlainObject(obj));

  // Prefer the latest complete object with candidates and a finishReason
  // (the terminal generateContent shape). A candidate is only treated as a
  // complete terminal object when its content carries an explicit role —
  // streaming fragments often omit role even when finishReason is set early.
  for (let i = typed.length - 1; i >= 0; i -= 1) {
    const obj = typed[i];
    const candidates = obj.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const first = candidates[0];
    if (!isPlainObject(first)) continue;
    const firstRec = first as Record<string, unknown>;
    if (typeof firstRec.finishReason !== "string") continue;
    const content = firstRec.content;
    if (!isPlainObject(content)) continue;
    const contentRec = content as Record<string, unknown>;
    if (typeof contentRec.role !== "string") continue;
    return { ...obj };
  }

  // Synthesis path: merge text parts + metadata across fragments.
  const textParts: string[] = [];
  let lastFinishReason: string | undefined;
  let lastUsageMetadata: Record<string, unknown> | undefined;
  let lastModelVersion: string | undefined;
  let lastModelVersionSnake: string | undefined;
  let lastResponseId: string | undefined;
  let lastPromptFeedback: Record<string, unknown> | undefined;
  let sawCandidates = false;

  for (const obj of typed) {
    const candidates = obj.candidates;
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        if (!isPlainObject(candidate)) continue;
        sawCandidates = true;
        const c = candidate as Record<string, unknown>;
        if (typeof c.finishReason === "string") {
          lastFinishReason = c.finishReason;
        }
        const content = c.content;
        if (isPlainObject(content)) {
          const parts = (content as Record<string, unknown>).parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (
                isPlainObject(part) &&
                typeof (part as Record<string, unknown>).text === "string"
              ) {
                textParts.push((part as Record<string, unknown>).text as string);
              }
            }
          }
        }
      }
    }
    if (isPlainObject(obj.usageMetadata)) {
      lastUsageMetadata = { ...(obj.usageMetadata as Record<string, unknown>) };
    }
    if (typeof obj.modelVersion === "string") {
      lastModelVersion = obj.modelVersion;
    }
    if (typeof obj.model_version === "string") {
      lastModelVersionSnake = obj.model_version;
    }
    if (typeof obj.responseId === "string") {
      lastResponseId = obj.responseId;
    }
    if (isPlainObject(obj.promptFeedback)) {
      lastPromptFeedback = { ...(obj.promptFeedback as Record<string, unknown>) };
    }
  }

  if (!sawCandidates || textParts.length === 0 || !lastFinishReason) {
    // Cannot form a coherent final candidate — refuse.
    return null;
  }

  const result: NormalizedLangfuseOutput = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: textParts.join("") }],
        },
        finishReason: lastFinishReason,
      },
    ],
  };
  if (lastUsageMetadata) {
    result.usageMetadata = lastUsageMetadata;
  }
  if (lastModelVersion) {
    result.modelVersion = lastModelVersion;
  }
  if (lastModelVersionSnake) {
    result.model_version = lastModelVersionSnake;
  }
  if (lastResponseId) {
    result.responseId = lastResponseId;
  }
  if (lastPromptFeedback) {
    result.promptFeedback = lastPromptFeedback;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
