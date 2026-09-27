/**
 * /api/internal/edge 路由：远端 edge 执行器与控制面之间的节点间接口。
 *
 * - 认证：x-cch-edge-secret 共享密钥（CCH_EDGE_SHARED_SECRET 未配置时整体 503）
 * - 所有请求体经 zod 校验；业务错误以 {error:{code,message}} 返回对应状态码
 */
import { Hono } from "hono";
import type { z } from "zod";
import { logger } from "@/lib/logger";
import { verifyEdgeRequest } from "./auth";
import {
  CompleteRequestSchema,
  HeartbeatRequestSchema,
  NextRequestSchema,
  RequestDigestSchema,
} from "./contract";
import { handleEdgeDecide } from "./decide";
import {
  EdgeHandlerError,
  handleEdgeComplete,
  handleEdgeHeartbeat,
  handleEdgeNext,
} from "./handlers";
import { EdgeStateLockTimeoutError, EdgeStateUnavailableError } from "./state-store";

export const EDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const EDGE_ID_HEADER = "x-cch-edge-id";

function errorBody(code: string, message: string = code) {
  return { error: { code, message } };
}

class EdgeBadRequestError extends Error {}

async function readJson<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > EDGE_MAX_BODY_BYTES) {
    throw new EdgeBadRequestError("payload_too_large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > EDGE_MAX_BODY_BYTES) {
    throw new EdgeBadRequestError("payload_too_large");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EdgeBadRequestError("invalid_json");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new EdgeBadRequestError(`invalid_payload: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data;
}

export const edgeApp = new Hono().basePath("/api/internal/edge");

edgeApp.use("*", async (c, next) => {
  const auth = verifyEdgeRequest(c.req.raw.headers);
  if (auth === "not_configured") {
    return c.json(errorBody("edge_not_configured"), 503);
  }
  if (auth !== "ok") {
    return c.json(errorBody("unauthorized"), 401);
  }
  await next();
});

edgeApp.onError((error, c) => {
  if (error instanceof EdgeBadRequestError) {
    const code = error.message.split(":")[0];
    return c.json(errorBody(code, error.message), code === "payload_too_large" ? 413 : 400);
  }
  if (error instanceof EdgeHandlerError) {
    return c.json(errorBody(error.code, error.message), error.status as 400);
  }
  if (error instanceof EdgeStateUnavailableError) {
    return c.json(errorBody("state_store_unavailable"), 503);
  }
  if (error instanceof EdgeStateLockTimeoutError) {
    return c.json(errorBody("request_busy"), 409);
  }
  logger.error("[EdgeRouter] Unhandled edge control-plane error", {
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
  });
  return c.json(errorBody("internal_error"), 500);
});

edgeApp.get("/health", (c) => c.json({ ok: true }));

edgeApp.post("/decide", async (c) => {
  const digest = await readJson(c.req.raw, RequestDigestSchema);
  const edgeId = c.req.header(EDGE_ID_HEADER) || digest.edgeId;
  return c.json(await handleEdgeDecide(digest, edgeId));
});

edgeApp.post("/next", async (c) => {
  return c.json(await handleEdgeNext(await readJson(c.req.raw, NextRequestSchema)));
});

edgeApp.post("/complete", async (c) => {
  return c.json(await handleEdgeComplete(await readJson(c.req.raw, CompleteRequestSchema)));
});

edgeApp.post("/heartbeat", async (c) => {
  return c.json(await handleEdgeHeartbeat(await readJson(c.req.raw, HeartbeatRequestSchema)));
});
