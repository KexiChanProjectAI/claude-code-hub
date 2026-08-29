import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { authorizeMetricsRequest, getCchMetrics, isMetricsEnabled } from "@/lib/metrics";
import { collectGaugeSnapshot } from "@/lib/metrics/gauges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isMetricsEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!authorizeMetricsRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const metrics = getCchMetrics();
  try {
    metrics.applyGaugeSnapshot(await collectGaugeSnapshot());
  } catch (error) {
    logger.warn("[metrics] Gauge collection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const body = await metrics.registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": metrics.registry.contentType,
      "Cache-Control": "no-store",
    },
  });
}
