import "server-only";

import type { UpstreamQuotaConcreteProbeType } from "@/types/upstream-quota";
import type { UpstreamQuotaProber } from "../types";
import { kimiCodingProber } from "./kimi-coding";
import { miniMaxCodingProber } from "./minimax-coding";
import { openCodeGoProber } from "./opencode-go";
import { zhipuCodingProber } from "./zhipu-coding";

export const UPSTREAM_QUOTA_PROBERS: Record<UpstreamQuotaConcreteProbeType, UpstreamQuotaProber> = {
  "kimi-coding": kimiCodingProber,
  "zhipu-coding": zhipuCodingProber,
  "minimax-coding": miniMaxCodingProber,
  "opencode-go": openCodeGoProber,
};
