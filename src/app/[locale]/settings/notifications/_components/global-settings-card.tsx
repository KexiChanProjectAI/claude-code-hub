"use client";

import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface GlobalSettingsCardProps {
  enabled: boolean;
  titlePrefix: string;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
  onTitlePrefixChange: (titlePrefix: string) => void | Promise<void>;
}

export function GlobalSettingsCard({
  enabled,
  titlePrefix,
  onEnabledChange,
  onTitlePrefixChange,
}: GlobalSettingsCardProps) {
  const t = useTranslations("settings");
  const [prefixDraft, setPrefixDraft] = useState(titlePrefix);

  useEffect(() => {
    setPrefixDraft(titlePrefix);
  }, [titlePrefix]);

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "p-4 rounded-xl border flex items-center justify-between gap-4 transition-colors",
          enabled
            ? "bg-primary/5 border-primary/20 hover:border-primary/30"
            : "bg-card/30 border-border/50 hover:border-border"
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "w-10 h-10 flex items-center justify-center rounded-xl shrink-0",
              enabled ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground"
            )}
          >
            <Bell className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {t("notifications.global.title")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("notifications.global.description")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={cn(
              "text-xs font-medium px-2 py-0.5 rounded-full",
              enabled ? "bg-green-500/10 text-green-400" : "bg-muted text-muted-foreground"
            )}
          >
            {enabled ? t("notifications.global.on") : t("notifications.global.off")}
          </span>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
      </div>
      <div className="p-4 rounded-xl border bg-card/30 border-border/50 space-y-1.5">
        <label
          htmlFor="notificationTitlePrefix"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("notifications.global.titlePrefix")}
        </label>
        <input
          id="notificationTitlePrefix"
          value={prefixDraft}
          maxLength={64}
          disabled={!enabled}
          placeholder={t("notifications.global.titlePrefixPlaceholder")}
          onChange={(event) => setPrefixDraft(event.target.value)}
          onBlur={() => {
            if (prefixDraft !== titlePrefix) {
              void onTitlePrefixChange(prefixDraft);
            }
          }}
          className={cn(
            "w-full bg-muted/50 border border-border rounded-lg py-2 px-3 text-sm text-foreground",
            "focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        />
        <p className="text-xs text-muted-foreground">{t("notifications.global.titlePrefixHelp")}</p>
      </div>
    </div>
  );
}
