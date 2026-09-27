import type {
  UpstreamQuotaConcreteProbeType,
  UpstreamQuotaProbeOptions,
  UpstreamQuotaProbeType,
  UpstreamQuotaWindow,
} from "@/types/upstream-quota";

/** Minimal provider shape needed to probe upstream quota. */
export interface UpstreamQuotaProbeTarget {
  id: number;
  name: string;
  url: string;
  key: string;
  proxyUrl: string | null;
  proxyFallbackToDirect: boolean;
  customHeaders: Record<string, string> | null;
  upstreamQuotaProbeType: UpstreamQuotaProbeType;
  upstreamQuotaProbeOptions: UpstreamQuotaProbeOptions | null;
}

export type UpstreamQuotaProbeFailureKind =
  | "credential_invalid"
  | "insufficient_balance"
  | "http_error"
  | "network"
  | "parse";

export type UpstreamQuotaProbeResult =
  | { ok: true; windows: UpstreamQuotaWindow[]; planLevel: string | null }
  | {
      ok: false;
      kind: UpstreamQuotaProbeFailureKind;
      statusCode?: number;
      message: string;
    };

export interface UpstreamQuotaProber {
  type: UpstreamQuotaConcreteProbeType;
  probe(target: UpstreamQuotaProbeTarget): Promise<UpstreamQuotaProbeResult>;
}
