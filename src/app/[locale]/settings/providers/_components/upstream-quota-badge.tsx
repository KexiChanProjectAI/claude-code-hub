"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass, RefreshCw } from "lucide-react";
import { useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getProvidersUpstreamQuotaStatus,
  refreshProviderUpstreamQuota,
} from "@/lib/api-client/v1/actions/providers";
import { cn } from "@/lib/utils";
import type {
  ProviderUpstreamQuotaStatus,
  ProviderUpstreamQuotaStatusMap,
  UpstreamQuotaWindow,
} from "@/types/upstream-quota";

export const PROVIDERS_UPSTREAM_QUOTA_QUERY_KEY = ["providers-upstream-quota"] as const;

const STATUS_CLASS: Record<ProviderUpstreamQuotaStatus["verdict"]["status"], string> = {
  ok: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-700",
  low: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700",
  exhausted:
    "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-700",
  unknown: "text-muted-foreground",
};

const BAR_CLASS: Record<ProviderUpstreamQuotaStatus["verdict"]["status"], string> = {
  ok: "bg-emerald-500",
  low: "bg-amber-500",
  exhausted: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

/** Shared query: every badge subscribes to the same cached map. */
export function useProvidersUpstreamQuota(enabled: boolean) {
  return useQuery<ProviderUpstreamQuotaStatusMap>({
    queryKey: PROVIDERS_UPSTREAM_QUOTA_QUERY_KEY,
    queryFn: getProvidersUpstreamQuotaStatus,
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function formatDuration(ms: number, t: ReturnType<typeof useTranslations>): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t("durationDaysHours", { days, hours });
  if (hours > 0) return t("durationHoursMinutes", { hours, minutes });
  return t("durationMinutes", { minutes });
}

function WindowRow({
  window,
  now,
  status,
}: {
  window: UpstreamQuotaWindow;
  now: number;
  status: ProviderUpstreamQuotaStatus["verdict"]["status"];
}) {
  const t = useTranslations("settings.providers.list.upstreamQuota");
  const expired = window.resetAt !== null && window.resetAt <= now;
  const used = expired ? 0 : Math.min(100, Math.max(0, window.usedPercent));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="font-medium">{t(`windows.${window.window}`)}</span>
        <span className="font-mono">{t("used", { percent: Math.round(used) })}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", BAR_CLASS[status])}
          style={{ width: `${used}%` }}
        />
      </div>
      {window.resetAt !== null && !expired && (
        <div className="text-[11px] text-muted-foreground">
          {t("resetsIn", { duration: formatDuration(window.resetAt - now, t) })}
        </div>
      )}
    </div>
  );
}

interface UpstreamQuotaBadgeProps {
  providerId: number;
  canRefresh: boolean;
  className?: string;
}

export function UpstreamQuotaBadge({ providerId, canRefresh, className }: UpstreamQuotaBadgeProps) {
  const t = useTranslations("settings.providers.list.upstreamQuota");
  const queryClient = useQueryClient();
  const now = useNow({ updateInterval: 60_000 }).getTime();
  const [refreshing, setRefreshing] = useState(false);
  const { data } = useProvidersUpstreamQuota(canRefresh);
  const status = data?.[providerId];

  if (!status) return null;
  const { verdict, snapshot } = status;
  const canProbe = status.resolvedProbeType !== "none";
  if (!canProbe && verdict.status !== "exhausted") return null;

  const label =
    verdict.status === "exhausted"
      ? t("statusExhausted")
      : verdict.remainingPercent !== undefined
        ? t(verdict.status === "low" ? "statusLow" : "statusOk", {
            percent: Math.floor(verdict.remainingPercent),
          })
        : t("statusUnknown");

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await refreshProviderUpstreamQuota(providerId);
      if (!result.ok) {
        toast.error(t("refreshFailed"), { description: result.error });
        return;
      }
      queryClient.setQueryData<ProviderUpstreamQuotaStatusMap>(
        PROVIDERS_UPSTREAM_QUOTA_QUERY_KEY,
        (previous) => ({ ...(previous ?? {}), [providerId]: result.data })
      );
      if (result.data.snapshot?.lastError && result.data.snapshot.fetchedAt === null) {
        toast.error(t("refreshFailed"), { description: result.data.snapshot.lastError });
      } else {
        toast.success(t("refreshSuccess"));
      }
    } finally {
      setRefreshing(false);
    }
  };

  const reactivePaused =
    snapshot?.reactivePauseUntil !== null &&
    snapshot?.reactivePauseUntil !== undefined &&
    snapshot.reactivePauseUntil > now;

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn("flex items-center gap-1 cursor-default", STATUS_CLASS[verdict.status])}
          >
            <Hourglass className="h-3 w-3" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="w-64 space-y-2 p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold">{t("title")}</span>
            <span className="text-muted-foreground">
              {t(`probeTypes.${status.resolvedProbeType}`)}
            </span>
          </div>
          {snapshot?.planLevel && (
            <div className="text-xs text-muted-foreground">
              {t("plan", { plan: snapshot.planLevel })}
            </div>
          )}
          {snapshot?.windows.map((window) => (
            <WindowRow key={window.window} window={window} now={now} status={verdict.status} />
          ))}
          {verdict.status === "unknown" && (
            <div className="text-xs text-muted-foreground">
              {verdict.reason === "stale_snapshot" ? t("stale") : t("noData")}
            </div>
          )}
          {reactivePaused && snapshot?.reactivePauseUntil && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {t("reactivePaused", {
                duration: formatDuration(snapshot.reactivePauseUntil - now, t),
              })}
            </div>
          )}
          {snapshot && !snapshot.credentialValid && (
            <div className="text-xs text-red-600 dark:text-red-400">{t("credentialInvalid")}</div>
          )}
          {snapshot?.lastError && (
            <div className="break-all text-[11px] text-muted-foreground">
              {t("lastError", { error: snapshot.lastError })}
            </div>
          )}
          {verdict.thresholdPercent !== undefined && (
            <div className="text-[11px] text-muted-foreground">
              {t("threshold", { percent: verdict.thresholdPercent })}
            </div>
          )}
          {snapshot?.fetchedAt && (
            <div className="text-[11px] text-muted-foreground">
              {t("updatedAgo", { duration: formatDuration(now - snapshot.fetchedAt, t) })}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      {canRefresh && canProbe && (
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label={t("refresh")}
          title={t("refresh")}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
        </button>
      )}
    </span>
  );
}
