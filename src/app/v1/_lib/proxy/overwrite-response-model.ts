const DATA_PREFIX = "data:";
const DONE_PAYLOAD = "[DONE]";
const MAX_REWRITE_BUFFER_CHARACTERS = 1024 * 1024;

export function shouldOverwriteResponseModel(
  enabled: boolean | null | undefined,
  requestedModel: string | null | undefined
): requestedModel is string {
  return Boolean(enabled) && typeof requestedModel === "string" && requestedModel.length > 0;
}

export function overwriteResponseModelFields(value: unknown, modelId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  let changed = false;

  if (typeof obj.model === "string" && obj.model !== modelId) {
    obj.model = modelId;
    changed = true;
  }
  if (typeof obj.modelVersion === "string" && obj.modelVersion !== modelId) {
    obj.modelVersion = modelId;
    changed = true;
  }
  if (typeof obj.model_version === "string" && obj.model_version !== modelId) {
    obj.model_version = modelId;
    changed = true;
  }

  if (obj.response && typeof obj.response === "object" && !Array.isArray(obj.response)) {
    const nested = obj.response as Record<string, unknown>;
    if (typeof nested.model === "string" && nested.model !== modelId) {
      nested.model = modelId;
      changed = true;
    }
  }

  if (obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)) {
    const nested = obj.message as Record<string, unknown>;
    if (typeof nested.model === "string" && nested.model !== modelId) {
      nested.model = modelId;
      changed = true;
    }
  }

  return changed;
}

export function overwriteResponseModelInText(text: string, modelId: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  try {
    const parsed: unknown = JSON.parse(text);
    if (overwriteResponseModelFields(parsed, modelId)) {
      return JSON.stringify(parsed);
    }
    return text;
  } catch {
    return overwriteResponseModelInStreamText(text, modelId);
  }
}

export function overwriteResponseModelInStreamText(text: string, modelId: string): string {
  if (!text) return text;
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const rewritten = lines.map((line) => overwriteResponseModelInStreamLine(line, modelId));
  return endsWithNewline ? `${rewritten.join("\n")}\n` : rewritten.join("\n");
}

export function createOverwriteResponseModelTransform(
  modelId: string
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const flushCompleteLines = (controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    if (buffer.length > MAX_REWRITE_BUFFER_CHARACTERS) {
      controller.enqueue(encoder.encode(buffer));
      buffer = "";
    }
    for (const line of lines) {
      controller.enqueue(encoder.encode(`${overwriteResponseModelInStreamLine(line, modelId)}\n`));
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      flushCompleteLines(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(overwriteResponseModelInStreamLine(buffer, modelId)));
        buffer = "";
      }
    },
  });
}

function overwriteResponseModelInStreamLine(line: string, modelId: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed === DONE_PAYLOAD) return line;

  if (trimmed.startsWith(DATA_PREFIX)) {
    const payload = trimmed.slice(DATA_PREFIX.length).trim();
    if (!payload || payload === DONE_PAYLOAD) return line;
    const rewritten = rewriteJsonPayload(payload, modelId);
    if (rewritten === payload) return line;
    const prefix = line.slice(0, line.indexOf(trimmed));
    const suffix = line.endsWith("\r") ? "\r" : "";
    return `${prefix}${DATA_PREFIX} ${rewritten}${suffix}`;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const rewritten = rewriteJsonPayload(trimmed, modelId);
    if (rewritten === trimmed) return line;
    return rewritten;
  }

  return line;
}

function rewriteJsonPayload(payload: string, modelId: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!overwriteResponseModelFields(parsed, modelId)) return payload;
    return JSON.stringify(parsed);
  } catch {
    return payload;
  }
}

export function overwriteClientFacingStream(
  enabled: boolean | null | undefined,
  requestedModel: string | null | undefined,
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  if (!shouldOverwriteResponseModel(enabled, requestedModel)) return stream;
  return stream.pipeThrough(createOverwriteResponseModelTransform(requestedModel));
}

export async function overwriteClientFacingJsonResponse(
  enabled: boolean | null | undefined,
  requestedModel: string | null | undefined,
  response: Response
): Promise<Response> {
  if (!shouldOverwriteResponseModel(enabled, requestedModel)) return response;
  const text = await response.text();
  const rewritten = overwriteResponseModelInText(text, requestedModel);
  const headers = new Headers(response.headers);
  if (rewritten !== text) headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
