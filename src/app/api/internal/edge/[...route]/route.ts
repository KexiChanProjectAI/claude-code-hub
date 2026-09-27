import { handle } from "hono/vercel";
import { edgeApp } from "@/app/v1/_lib/edge/router";
import { withDataDbScope } from "@/drizzle/db";
import { logger } from "@/lib/logger";
import { sensitiveWordDetector } from "@/lib/sensitive-word-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// edge 资格判定依赖敏感词缓存是否为空：与 /v1 路由相同的预热，保证本 worker 的判定准确
if (process.env.DSN?.trim() && process.env.NEXT_PHASE !== "phase-production-build") {
  sensitiveWordDetector.reload().catch((err) => {
    logger.error("[EdgeRoute] SensitiveWordDetector initialization failed:", err);
  });
}

const routeHandler = withDataDbScope(handle(edgeApp));

export { routeHandler as GET, routeHandler as POST };
