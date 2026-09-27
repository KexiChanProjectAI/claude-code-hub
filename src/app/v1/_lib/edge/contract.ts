/**
 * Edge 执行器与控制面之间的线协议（schemaVersion 1）。
 *
 * 控制面（本服务）负责全部决策：鉴权、限流、选路、重试/failover/hedge、计费结算；
 * 远端 Go 执行器只负责按 ExecutionStep 发起上游调用并回传结果。
 * 本文件是 TS 侧的唯一定义，Go 侧结构体（edge/internal/contract）必须与之逐字段一致。
 */
import { z } from "zod";

export const EDGE_SCHEMA_VERSION = 1;

/** 请求头以 [name, value] 列表传输：name 小写，保留重复头与顺序 */
export const HeaderPairsSchema = z
  .array(z.tuple([z.string().max(256), z.string().max(16_384)]))
  .max(512);
export type HeaderPairs = z.infer<typeof HeaderPairsSchema>;

/** 合成请求体允许携带的顶层字段（只含守卫链与转发准备读取的字段） */
export const EDGE_TOP_LEVEL_KEYS = [
  "model",
  "stream",
  "stream_options",
  "max_tokens",
  "thinking",
  "output_config",
  "reasoning_effort",
  "reasoning",
  "text",
  "service_tier",
  "parallel_tool_calls",
  "prompt_cache_key",
  "previous_response_id",
  "metadata",
] as const;
export type EdgeTopLevelKey = (typeof EDGE_TOP_LEVEL_KEYS)[number];

/** body op 可改写的顶层字段 */
export const EDGE_MUTABLE_TOP_LEVEL_KEYS = [
  "model",
  "max_tokens",
  "thinking",
  "output_config",
  "reasoning_effort",
  "reasoning",
  "text",
  "service_tier",
  "parallel_tool_calls",
  "prompt_cache_key",
  "stream_options",
  "metadata",
] as const;
export type EdgeMutableTopLevelKey = (typeof EDGE_MUTABLE_TOP_LEVEL_KEYS)[number];

const FingerprintBoundarySchema = z.object({
  depth: z.number().int().min(0),
  fp: z.string().regex(/^[0-9a-f]{32}$/),
  prefixBytes: z.number().int().min(0),
  hasCacheControl: z.boolean().optional(),
});

export const FingerprintChainSchema = z.object({
  sys: FingerprintBoundarySchema,
  tail: z.array(FingerprintBoundarySchema).max(64),
});

/** edge 可执行的客户端格式（与 detectFormatByEndpoint 结果一致） */
export const EDGE_CLIENT_FORMATS = ["claude", "response", "openai"] as const;
export type EdgeClientFormat = (typeof EDGE_CLIENT_FORMATS)[number];

export const RequestDigestSchema = z.object({
  schemaVersion: z.literal(EDGE_SCHEMA_VERSION),
  edgeId: z.string().min(1).max(128),
  edgeRequestId: z.string().min(1).max(128),
  receivedAtMs: z.number().int().positive(),
  method: z.string().min(1).max(16),
  /** 原始请求路径（含 query），如 /v1/messages?beta=true */
  path: z.string().min(1).max(8192),
  /** 由规范化后的路径决定的客户端格式 */
  format: z.enum(EDGE_CLIENT_FORMATS),
  headers: HeaderPairsSchema,
  clientIp: z.string().max(256).nullable(),
  bodyBytes: z.number().int().min(0),
  bodyParseError: z.string().max(1024).nullable(),
  /** 请求体中实际存在的顶层字段原值（缺失的键不出现，区分 absent 与 null） */
  topLevel: z.partialRecord(z.enum(EDGE_TOP_LEVEL_KEYS), z.unknown()),
  /**
   * messages / input 为数组时的长度，否则为 null（合成请求体据此放置等长占位数组）。
   * response 格式按 Response Input Rectifier 规范化后的请求体计算。
   */
  messagesCount: z.number().int().min(0).nullable(),
  inputCount: z.number().int().min(0).nullable(),
  /** rectifyResponseInput 在请求体副本上的结果（仅 response 格式；其他格式为 null） */
  responseInputRectify: z
    .object({
      action: z.enum([
        "string_to_array",
        "object_to_array",
        "empty_string_to_empty_array",
        "passthrough",
      ]),
      originalType: z.enum(["string", "object", "array", "other"]),
    })
    .nullable(),
  /** isRemoteCompactionV2Request 结果（此类请求走 raw passthrough，必须交回本地） */
  isRemoteCompactionV2: z.boolean(),
  /** Codex 会话补全指纹用的首轮消息文本哈希（extractInitialMessageTextHash） */
  codexInitialTextHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
  systemKind: z.enum(["absent", "string", "array", "other"]),
  hasPrivateParams: z.boolean(),
  isProbe: z.boolean(),
  isWarmup: z.boolean(),
  messagesHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
  fingerprint: FingerprintChainSchema.nullable(),
});
export type RequestDigest = z.infer<typeof RequestDigestSchema>;

export const BodyOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_top_level"),
    key: z.enum(EDGE_MUTABLE_TOP_LEVEL_KEYS),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("delete_top_level"), key: z.enum(EDGE_MUTABLE_TOP_LEVEL_KEYS) }),
  z.object({ op: z.literal("remove_system_billing_header") }),
  z.object({ op: z.literal("set_cache_control_ttl"), ttl: z.enum(["5m", "1h"]) }),
  z.object({ op: z.literal("apply_thinking_signature_rectifier") }),
  z.object({ op: z.literal("strip_private_params") }),
  z.object({ op: z.literal("normalize_response_input") }),
]);
export type BodyOp = z.infer<typeof BodyOpSchema>;

export const ExecutionStepSchema = z.object({
  stepId: z.string(),
  attemptNumber: z.number().int().min(1),
  totalProvidersAttempted: z.number().int().min(1),
  attemptKind: z.enum(["normal", "hedge"]),
  provider: z.object({
    id: z.number().int(),
    name: z.string(),
    priority: z.number(),
    type: z.enum(["claude", "claude-auth", "codex", "openai-compatible"]),
  }),
  /** 客户端格式：决定远端的门控协议族、紧凑 SSE 捕获与计量规则 */
  clientFormat: z.enum(EDGE_CLIENT_FORMATS),
  /**
   * codex 流式请求的 2xx 非 SSE / 非 HTML / 非 JSON 响应仍按流处理（与
   * shouldForceCodexResponsesStreamHandling 一致），此时不经过响应修复器。
   */
  forceStreamHandling: z.boolean(),
  endpoint: z.object({ id: z.number().int().nullable(), url: z.string() }),
  method: z.string(),
  url: z.string(),
  headers: HeaderPairsSchema,
  bodyOps: z.array(BodyOpSchema),
  /** 发起本步前等待的毫秒数（同供应商重试的退避） */
  delayMs: z.number().int().min(0),
  isStreaming: z.boolean(),
  timeouts: z.object({
    connectMs: z.number().int().min(0),
    firstByteMs: z.number().int().min(0),
    nonStreamTotalMs: z.number().int().min(0),
    idleMs: z.number().int().min(0),
    headersMs: z.number().int().min(0),
    bodyMs: z.number().int().min(0),
  }),
  transport: z.object({
    proxyUrl: z.string().nullable(),
    proxyFallbackToDirect: z.boolean(),
    http2: z.boolean(),
  }),
  gate: z.object({
    mode: z.enum(["off", "shadow", "enforce"]),
    highConcurrency: z.boolean(),
    idleMs: z.number().int().min(0),
    eventCap: z.number().int().min(1),
    byteCap: z.number().int().min(1),
    captureCommitMarker: z.boolean(),
  }),
  fixer: z.object({
    enabled: z.boolean(),
    fixTruncatedJson: z.boolean(),
    fixSseFormat: z.boolean(),
    fixEncoding: z.boolean(),
    maxJsonDepth: z.number().int().min(1),
    maxFixSize: z.number().int().min(1),
  }),
  /**
   * legacy hedge 竞速参数（null 表示串行模式）。thresholdMs 为本 attempt 的首字节竞速阈值，
   * 0 表示不触发 hedge_threshold；到期且未提交时远端调用 next(hedge_threshold)。
   */
  hedge: z
    .object({
      thresholdMs: z.number().int().min(0),
      maxInFlight: z.number().int().min(1),
      billLosers: z.boolean(),
      loserDrainMs: z.number().int().min(1),
    })
    .nullable(),
  reporting: z.object({
    maxCompactBytes: z.number().int().min(1),
    maxHeadBytes: z.number().int().min(0),
    maxNonStreamBodyBytes: z.number().int().min(1),
    maxErrorBodyBytes: z.number().int().min(1),
    heartbeatIntervalMs: z.number().int().min(1),
  }),
  clientAbortDrainMs: z.number().int().min(0),
});
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

export const FailResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: HeaderPairsSchema,
  /** 预先序列化的响应体，Go 原样写回（保证与本地路径逐字节一致） */
  bodyText: z.string(),
});
export type FailResponse = z.infer<typeof FailResponseSchema>;

/** 远端对本次 attempt 实际执行的内容型 op 的结果（控制面据此补齐审计与合成体状态） */
export const OpResultsSchema = z.object({
  billingHeader: z
    .object({ removedCount: z.number().int().min(0), extractedValues: z.array(z.string()) })
    .optional(),
  thinkingSignature: z
    .object({
      applied: z.boolean(),
      removedThinkingBlocks: z.number().int().min(0),
      removedRedactedThinkingBlocks: z.number().int().min(0),
      removedSignatureFields: z.number().int().min(0),
      /** 整流删除了顶层 thinking（最后一条 assistant 消息以 tool_use 开头） */
      removedTopLevelThinking: z.boolean(),
    })
    .optional(),
});
export type OpResults = z.infer<typeof OpResultsSchema>;

export const AttemptTimingSchema = z.object({
  /** 上游请求派发时刻（epoch ms）；未派发为 null */
  dispatchedAtMs: z.number().nullable(),
  firstByteAtMs: z.number().nullable(),
  endedAtMs: z.number(),
  /** 首字节健康归因耗时（已扣除 prebuffer 预算等待） */
  healthElapsedMs: z.number().min(0),
});

export const AttemptFailureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upstream_status"),
    status: z.number().int(),
    statusText: z.string(),
    headers: HeaderPairsSchema,
    bodyText: z.string(),
    bodyTruncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("transport"),
    code: z.string().max(64),
    message: z.string().max(1024),
  }),
  z.object({
    kind: z.literal("timeout"),
    timeoutType: z.enum([
      "streaming_first_byte",
      "non_streaming_total",
      "streaming_idle",
      "streaming_first_valid_content",
    ]),
  }),
  z.object({
    kind: z.literal("gate"),
    reason: z.enum(["gate_error", "decode_error", "empty_stream", "prebuffer_overflow"]),
    frameData: z.string().max(4096),
    inferenceText: z.string().max(65_536),
    terminalBeforeContent: z.boolean(),
    framesSeen: z.number().int().min(0),
    bufferedBytes: z.number().int().min(0),
    echoExcludedBytes: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("empty_response"),
    reason: z.enum(["empty_body", "missing_content"]),
  }),
  z.object({ kind: z.literal("client_abort") }),
  z.object({ kind: z.literal("local_capacity"), message: z.string().max(1024) }),
  z.object({ kind: z.literal("invalid_step"), message: z.string().max(1024) }),
]);
export type AttemptFailure = z.infer<typeof AttemptFailureSchema>;

export const NextEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("failure"),
    failure: AttemptFailureSchema,
    dispatched: z.boolean(),
    firstByteSeen: z.boolean(),
    timing: AttemptTimingSchema,
    opResults: OpResultsSchema.optional(),
    /**
     * 竞速模式下客户端在提交前断开：其余在途 attempt 的派发与计时（用于逐个做
     * client_abort_no_first_byte 健康归因）。
     */
    peers: z
      .array(
        z.object({
          stepId: z.string(),
          dispatched: z.boolean(),
          firstByteSeen: z.boolean(),
          healthElapsedMs: z.number().min(0),
        })
      )
      .max(16)
      .optional(),
  }),
  z.object({ type: z.literal("hedge_threshold") }),
  z.object({
    type: z.literal("rectifier_not_applicable"),
    opResults: OpResultsSchema.optional(),
  }),
  z.object({
    type: z.literal("suspect_2xx"),
    status: z.number().int(),
    headers: HeaderPairsSchema,
    bodyText: z.string(),
    bodyTruncated: z.boolean(),
    opResults: OpResultsSchema.optional(),
  }),
]);
export type NextEvent = z.infer<typeof NextEventSchema>;

export const NextRequestSchema = z.object({
  requestId: z.number().int(),
  edgeToken: z.string().min(16).max(128),
  stepId: z.string(),
  event: NextEventSchema,
});
export type NextRequest = z.infer<typeof NextRequestSchema>;

export type NextResponse =
  | { action: "retry"; step: ExecutionStep }
  | { action: "launch"; step: ExecutionStep }
  | { action: "wait" }
  | { action: "none" }
  | { action: "commit" }
  | { action: "fail"; response: FailResponse }
  | { action: "delegate"; reason: string };

export type DecideResponse =
  | { action: "delegate"; reason: string }
  | { action: "fail"; response: FailResponse }
  | {
      action: "execute";
      requestId: number;
      edgeToken: string;
      step: ExecutionStep;
    };

const ProtocolObservationSchema = z.object({
  sawContent: z.boolean(),
  sawTerminal: z.boolean(),
  sawIncomplete: z.boolean(),
  observationIncomplete: z.boolean(),
  failure: z
    .object({
      verdict: z.enum(["error", "malformed"]),
      eventName: z.string().nullable(),
      afterContent: z.boolean(),
      sawMalformed: z.boolean(),
    })
    .nullable(),
});

export const WinnerResultSchema = z.object({
  stepId: z.string(),
  upstreamStatus: z.number().int(),
  responseHeaders: HeaderPairsSchema,
  isStreaming: z.boolean(),
  streamEndedNormally: z.boolean(),
  clientAborted: z.boolean(),
  abortReason: z
    .enum([
      "STREAM_RESPONSE_TIMEOUT",
      "STREAM_IDLE_TIMEOUT",
      "CLIENT_ABORTED",
      "STREAM_UPSTREAM_ABORTED",
      "STREAM_PROCESSING_ERROR",
    ])
    .nullable(),
  firstByteSeen: z.boolean(),
  sseEventCount: z.number().int().min(0),
  /** 只含 message_start / message_delta / message_stop / error / signature_delta 帧的紧凑 SSE */
  compactSse: z.string(),
  compactTruncated: z.boolean(),
  nonStreamBody: z.object({ text: z.string(), truncated: z.boolean() }).nullable(),
  protocol: ProtocolObservationSchema.nullable(),
  gateCommit: z
    .object({
      frameIndex: z.number().int(),
      chunkIndex: z.number().int(),
      eventName: z.string().nullable(),
      bufferedBytes: z.number().int(),
      echoExcludedBytes: z.number().int(),
      gateWaitMs: z.number().int(),
    })
    .nullable(),
  /** 与本地 response_fixer 审计项同形；hit=false 时控制面不记录 */
  fixer: z
    .object({
      hit: z.boolean(),
      fixersApplied: z
        .array(
          z.object({
            fixer: z.enum(["json", "sse", "encoding"]),
            applied: z.boolean(),
            details: z.string().max(1024).optional(),
          })
        )
        .max(3),
      totalBytesProcessed: z.number().int().min(0),
      processingTimeMs: z.number().int().min(0),
    })
    .nullable(),
  timing: z.object({
    dispatchedAtMs: z.number(),
    firstByteAtMs: z.number().nullable(),
    firstTokenAtMs: z.number().nullable(),
    endedAtMs: z.number(),
    healthElapsedMs: z.number().min(0),
  }),
  bytesToClient: z.number().int().min(0),
  opResults: OpResultsSchema.optional(),
});
export type WinnerResult = z.infer<typeof WinnerResultSchema>;

export const LoserResultSchema = z.object({
  stepId: z.string(),
  upstreamStatus: z.number().int(),
  drainComplete: z.boolean(),
  /** client-abort-metering 同格式的紧凑证据文本；未计费排空时为空串 */
  meteringText: z.string(),
  endedAtMs: z.number(),
});
export type LoserResult = z.infer<typeof LoserResultSchema>;

export const CompleteRequestSchema = z.object({
  requestId: z.number().int(),
  edgeToken: z.string().min(16).max(128),
  winner: WinnerResultSchema,
  losers: z.array(LoserResultSchema).max(8),
});
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

export const HeartbeatRequestSchema = z.object({
  requestId: z.number().int(),
  edgeToken: z.string().min(16).max(128),
  bytesForwarded: z.number().int().min(0),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
