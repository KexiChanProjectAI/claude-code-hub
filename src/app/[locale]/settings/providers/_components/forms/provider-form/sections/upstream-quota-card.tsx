"use client";

import { Hourglass } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE } from "@/lib/provider-upstream-quota/constants";
import { resolveUpstreamQuotaProbeType } from "@/lib/provider-upstream-quota/detect";
import { UPSTREAM_QUOTA_PROBE_TYPES, type UpstreamQuotaProbeType } from "@/types/upstream-quota";
import { MixedValueIndicator } from "../../../batch-edit/mixed-value-indicator";
import { SectionCard, SmartInputWrapper } from "../components/section-card";
import { useProviderForm } from "../provider-form-context";

function parseThreshold(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(
    UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE[1],
    Math.max(UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE[0], value)
  );
}

export function UpstreamQuotaCard() {
  const t = useTranslations("settings.providers.form.sections.upstreamQuota");
  const { state, dispatch, mode, batchAnalysis } = useProviderForm();
  const isEdit = mode === "edit";
  const isBatch = mode === "batch";
  const { upstreamQuotaProbeType, upstreamQuotaThresholdPercent } = state.rateLimit;

  const resolved = resolveUpstreamQuotaProbeType({
    url: state.basic.url,
    upstreamQuotaProbeType,
  });
  const idPrefix = isEdit ? "edit-upstream-quota" : "upstream-quota";

  return (
    <SectionCard title={t("title")} description={t("desc")} icon={Hourglass}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SmartInputWrapper
            label={t("probeType.label")}
            description={
              !isBatch && upstreamQuotaProbeType === "auto"
                ? t("probeType.autoResolved", { type: t(`probeType.options.${resolved}`) })
                : t("probeType.desc")
            }
          >
            <Select
              value={upstreamQuotaProbeType}
              onValueChange={(value: UpstreamQuotaProbeType) =>
                dispatch({ type: "SET_UPSTREAM_QUOTA_PROBE_TYPE", payload: value })
              }
              disabled={state.ui.isPending}
            >
              <SelectTrigger id={`${idPrefix}-probe-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPSTREAM_QUOTA_PROBE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`probeType.options.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isBatch && batchAnalysis?.rateLimit.upstreamQuotaProbeType.status === "mixed" && (
              <MixedValueIndicator values={batchAnalysis.rateLimit.upstreamQuotaProbeType.values} />
            )}
          </SmartInputWrapper>

          <SmartInputWrapper label={t("threshold.label")} description={t("threshold.desc")}>
            <div className="relative">
              <Input
                id={`${idPrefix}-threshold`}
                type="number"
                min={UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE[0]}
                max={UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE[1]}
                step={1}
                value={upstreamQuotaThresholdPercent?.toString() ?? ""}
                onChange={(event) =>
                  dispatch({
                    type: "SET_UPSTREAM_QUOTA_THRESHOLD_PERCENT",
                    payload: parseThreshold(event.target.value),
                  })
                }
                placeholder={t("threshold.placeholder")}
                disabled={state.ui.isPending || upstreamQuotaProbeType === "none"}
                className="pr-8 font-mono"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
            {isBatch &&
              batchAnalysis?.rateLimit.upstreamQuotaThresholdPercent.status === "mixed" && (
                <MixedValueIndicator
                  values={batchAnalysis.rateLimit.upstreamQuotaThresholdPercent.values}
                />
              )}
          </SmartInputWrapper>
        </div>

        {!isBatch && resolved === "zhipu-coding" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SmartInputWrapper
              label={t("zhipuOrganization.label")}
              description={t("zhipuOrganization.desc")}
            >
              <Input
                id={`${idPrefix}-zhipu-organization`}
                value={state.rateLimit.upstreamQuotaZhipuOrganization}
                onChange={(event) =>
                  dispatch({
                    type: "SET_UPSTREAM_QUOTA_ZHIPU_ORGANIZATION",
                    payload: event.target.value,
                  })
                }
                placeholder={t("zhipuOrganization.placeholder")}
                disabled={state.ui.isPending}
                className="font-mono"
              />
            </SmartInputWrapper>
            <SmartInputWrapper label={t("zhipuProject.label")} description={t("zhipuProject.desc")}>
              <Input
                id={`${idPrefix}-zhipu-project`}
                value={state.rateLimit.upstreamQuotaZhipuProject}
                onChange={(event) =>
                  dispatch({
                    type: "SET_UPSTREAM_QUOTA_ZHIPU_PROJECT",
                    payload: event.target.value,
                  })
                }
                placeholder={t("zhipuProject.placeholder")}
                disabled={state.ui.isPending || !state.rateLimit.upstreamQuotaZhipuOrganization}
                className="font-mono"
              />
            </SmartInputWrapper>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
