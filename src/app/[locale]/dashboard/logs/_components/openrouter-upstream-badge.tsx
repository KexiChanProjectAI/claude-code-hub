"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { getOpenRouterUpstreamProviderSpecialSetting } from "@/lib/utils/special-settings";
import type { SpecialSetting } from "@/types/special-settings";

interface OpenRouterUpstreamBadgeProps {
  specialSettings?: SpecialSetting[] | null;
}

/** Compact badge with the provider OpenRouter actually routed the request to. */
export function OpenRouterUpstreamBadge({ specialSettings }: OpenRouterUpstreamBadgeProps) {
  const t = useTranslations("dashboard.logs.details.openrouterUpstream");
  const setting = getOpenRouterUpstreamProviderSpecialSetting(specialSettings);
  if (!setting) return null;

  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1 py-0 shrink-0 max-w-[120px] truncate bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800"
      title={t("badgeTitle", { provider: setting.upstreamProvider })}
      data-testid="openrouter-upstream-badge"
    >
      {setting.upstreamProvider}
    </Badge>
  );
}
