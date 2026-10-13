"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getProvidersUpstreamGzipStatus } from "@/lib/api-client/v1/actions/providers";
import { cn } from "@/lib/utils";
import type {
  ProviderUpstreamGzipStatusMap,
  UpstreamGzipRequestState,
  UpstreamGzipResponseState,
} from "@/types/upstream-gzip";

export const PROVIDERS_UPSTREAM_GZIP_QUERY_KEY = ["providers-upstream-gzip"] as const;

type GzipState = UpstreamGzipRequestState | UpstreamGzipResponseState;

const ICON_CLASS: Record<GzipState, string> = {
  supported: "text-emerald-600 dark:text-emerald-400",
  compressed: "text-emerald-600 dark:text-emerald-400",
  unsupported: "text-amber-600 dark:text-amber-400",
  uncompressed: "text-muted-foreground",
  unknown: "text-muted-foreground/50",
  disabled: "text-muted-foreground/30",
};

/** Shared query: every badge subscribes to the same cached map. */
export function useProvidersUpstreamGzip(enabled: boolean) {
  return useQuery<ProviderUpstreamGzipStatusMap>({
    queryKey: PROVIDERS_UPSTREAM_GZIP_QUERY_KEY,
    queryFn: getProvidersUpstreamGzipStatus,
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

interface UpstreamGzipBadgeProps {
  providerId: number;
  enabled: boolean;
  className?: string;
}

export function UpstreamGzipBadge({ providerId, enabled, className }: UpstreamGzipBadgeProps) {
  const t = useTranslations("settings.providers.list.upstreamGzip");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { data } = useProvidersUpstreamGzip(enabled);
  const status = data?.[providerId];

  if (!status) return null;
  const { request, response } = status;
  if (request.state === "disabled" && response.state === "disabled") return null;

  const rows = [
    {
      key: "request",
      Icon: ArrowUp,
      label: t("request"),
      state: request.state,
      text: t(`requestStates.${request.state}`),
      updatedAt: request.updatedAt,
    },
    {
      key: "response",
      Icon: ArrowDown,
      label: t("response"),
      state: response.state,
      text: t(`responseStates.${response.state}`),
      updatedAt: response.updatedAt,
    },
  ] as const;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("flex items-center gap-0.5 cursor-default font-mono", className)}
          aria-label={`${t("title")}: ${rows.map((row) => `${row.label} ${row.text}`).join(", ")}`}
        >
          {t("label")}
          {rows.map(({ key, Icon, state }) => (
            <Icon key={key} className={cn("h-3 w-3", ICON_CLASS[state])} />
          ))}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="w-64 space-y-2 p-3">
        <div className="text-xs font-semibold">{t("title")}</div>
        {rows.map(({ key, Icon, label, state, text, updatedAt }) => (
          <div key={key} className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1 font-medium">
                <Icon className={cn("h-3 w-3", ICON_CLASS[state])} />
                {label}
              </span>
              <span>{text}</span>
            </div>
            {updatedAt !== null && (
              <div className="text-[11px] text-muted-foreground">
                {t("updatedAt", { time: format.relativeTime(updatedAt, now) })}
              </div>
            )}
          </div>
        ))}
        <div className="text-[11px] text-muted-foreground">{t("hint")}</div>
      </TooltipContent>
    </Tooltip>
  );
}
