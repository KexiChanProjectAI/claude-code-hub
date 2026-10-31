"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  normalizeOpenRouterProviderRouting,
  OPENROUTER_MAX_PRICE_KEYS,
  OPENROUTER_QUANTIZATIONS,
  OPENROUTER_SORT_OPTIONS,
} from "@/lib/openrouter/provider-routing";
import { cn } from "@/lib/utils";
import type {
  OpenRouterMaxPriceKey,
  OpenRouterProviderRouting,
  OpenRouterQuantization,
  OpenRouterSort,
} from "@/types/provider";

type BooleanKey = "allow_fallbacks" | "require_parameters" | "zdr" | "enforce_distillable_text";
type ListKey = "order" | "only" | "ignore";
type NumberKey = "preferred_min_throughput" | "preferred_max_latency";

const BOOLEAN_KEYS: readonly BooleanKey[] = [
  "zdr",
  "allow_fallbacks",
  "require_parameters",
  "enforce_distillable_text",
];
const LIST_KEYS: readonly ListKey[] = ["order", "only", "ignore"];
const NUMBER_KEYS: readonly NumberKey[] = ["preferred_min_throughput", "preferred_max_latency"];

const INHERIT = "inherit";

export function parseSlugListText(text: string): string[] | undefined {
  const items = text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parseNonNegativeNumberText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Shallow-merge a patch, dropping keys whose value is undefined. */
export function patchOpenRouterRouting(
  current: OpenRouterProviderRouting,
  patch: Partial<OpenRouterProviderRouting>
): OpenRouterProviderRouting {
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as OpenRouterProviderRouting;
}

interface OpenRouterRoutingEditorProps {
  value: OpenRouterProviderRouting;
  onChange: (value: OpenRouterProviderRouting) => void;
  disabled?: boolean;
}

export function OpenRouterRoutingEditor({
  value,
  onChange,
  disabled,
}: OpenRouterRoutingEditorProps) {
  const t = useTranslations("settings.providers.form.sections.routing.openrouterRouting");

  const [listText, setListText] = useState<Record<ListKey, string>>(() => ({
    order: value.order?.join(", ") ?? "",
    only: value.only?.join(", ") ?? "",
    ignore: value.ignore?.join(", ") ?? "",
  }));
  const [priceText, setPriceText] = useState<Record<OpenRouterMaxPriceKey, string>>(() => ({
    prompt: value.max_price?.prompt?.toString() ?? "",
    completion: value.max_price?.completion?.toString() ?? "",
    request: value.max_price?.request?.toString() ?? "",
    image: value.max_price?.image?.toString() ?? "",
  }));
  const [numberText, setNumberText] = useState<Record<NumberKey, string>>(() => ({
    preferred_min_throughput: value.preferred_min_throughput?.toString() ?? "",
    preferred_max_latency: value.preferred_max_latency?.toString() ?? "",
  }));

  const update = (patch: Partial<OpenRouterProviderRouting>) =>
    onChange(patchOpenRouterRouting(value, patch));

  const toggleQuantization = (q: OpenRouterQuantization) => {
    const selected = new Set(value.quantizations ?? []);
    if (selected.has(q)) selected.delete(q);
    else selected.add(q);
    const next = OPENROUTER_QUANTIZATIONS.filter((item) => selected.has(item));
    update({ quantizations: next.length > 0 ? next : undefined });
  };

  const updatePrice = (key: OpenRouterMaxPriceKey, text: string) => {
    setPriceText((prev) => ({ ...prev, [key]: text }));
    const nextPrice: Partial<Record<OpenRouterMaxPriceKey, number>> = { ...value.max_price };
    const parsed = parseNonNegativeNumberText(text);
    if (parsed === undefined) delete nextPrice[key];
    else nextPrice[key] = parsed;
    update({ max_price: Object.keys(nextPrice).length > 0 ? nextPrice : undefined });
  };

  const preview = normalizeOpenRouterProviderRouting(value);

  return (
    <div className="space-y-5" data-testid="openrouter-routing-editor">
      {/* Sort + data collection */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-sm">{t("sort.label")}</Label>
          <Select
            value={value.sort ?? INHERIT}
            onValueChange={(val) =>
              update({ sort: val === INHERIT ? undefined : (val as OpenRouterSort) })
            }
            disabled={disabled}
          >
            <SelectTrigger className="w-full" data-testid="openrouter-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>{t("sort.options.default")}</SelectItem>
              {OPENROUTER_SORT_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`sort.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("sort.desc")}</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">{t("dataCollection.label")}</Label>
          <Select
            value={value.data_collection ?? INHERIT}
            onValueChange={(val) =>
              update({
                data_collection: val === INHERIT ? undefined : (val as "allow" | "deny"),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="w-full" data-testid="openrouter-data-collection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>{t("triState.inherit")}</SelectItem>
              <SelectItem value="allow">{t("dataCollection.options.allow")}</SelectItem>
              <SelectItem value="deny">{t("dataCollection.options.deny")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("dataCollection.desc")}</p>
        </div>
      </div>

      {/* Boolean switches as tri-state selects */}
      <div className="grid gap-4 sm:grid-cols-2">
        {BOOLEAN_KEYS.map((key) => (
          <div key={key} className="space-y-1.5">
            <Label className="text-sm">{t(`flags.${key}.label`)}</Label>
            <Select
              value={value[key] === undefined ? INHERIT : String(value[key])}
              onValueChange={(val) =>
                update({ [key]: val === INHERIT ? undefined : val === "true" } as Partial<
                  Pick<OpenRouterProviderRouting, BooleanKey>
                >)
              }
              disabled={disabled}
            >
              <SelectTrigger className="w-full" data-testid={`openrouter-flag-${key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{t("triState.inherit")}</SelectItem>
                <SelectItem value="true">{t("triState.on")}</SelectItem>
                <SelectItem value="false">{t("triState.off")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`flags.${key}.desc`)}</p>
          </div>
        ))}
      </div>

      {/* Quantizations */}
      <div className="space-y-1.5">
        <Label className="text-sm">{t("quantizations.label")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {OPENROUTER_QUANTIZATIONS.map((q) => {
            const active = value.quantizations?.includes(q) ?? false;
            return (
              <button
                key={q}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleQuantization(q)}
                data-testid={`openrouter-quantization-${q}`}
                className={cn(
                  "rounded-md border px-2 py-0.5 font-mono text-xs transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                  disabled && "cursor-not-allowed opacity-50"
                )}
              >
                {q}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("quantizations.desc")}</p>
      </div>

      {/* Provider lists */}
      <div className="grid gap-4 sm:grid-cols-3">
        {LIST_KEYS.map((key) => (
          <div key={key} className="space-y-1.5">
            <Label className="text-sm">{t(`lists.${key}.label`)}</Label>
            <Input
              value={listText[key]}
              onChange={(e) => {
                const text = e.target.value;
                setListText((prev) => ({ ...prev, [key]: text }));
                update({ [key]: parseSlugListText(text) } as Partial<
                  Pick<OpenRouterProviderRouting, ListKey>
                >);
              }}
              placeholder={t(`lists.${key}.placeholder`)}
              disabled={disabled}
              data-testid={`openrouter-list-${key}`}
            />
            <p className="text-xs text-muted-foreground">{t(`lists.${key}.desc`)}</p>
          </div>
        ))}
      </div>

      {/* Max price */}
      <div className="space-y-1.5">
        <Label className="text-sm">{t("maxPrice.label")}</Label>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          {OPENROUTER_MAX_PRICE_KEYS.map((key) => (
            <div key={key} className="space-y-1">
              <span className="text-xs text-muted-foreground">{t(`maxPrice.${key}`)}</span>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={priceText[key]}
                onChange={(e) => updatePrice(key, e.target.value)}
                disabled={disabled}
                data-testid={`openrouter-max-price-${key}`}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("maxPrice.desc")}</p>
      </div>

      {/* Performance thresholds */}
      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBER_KEYS.map((key) => (
          <div key={key} className="space-y-1.5">
            <Label className="text-sm">{t(`performance.${key}.label`)}</Label>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={numberText[key]}
              onChange={(e) => {
                const text = e.target.value;
                setNumberText((prev) => ({ ...prev, [key]: text }));
                update({ [key]: parseNonNegativeNumberText(text) } as Partial<
                  Pick<OpenRouterProviderRouting, NumberKey>
                >);
              }}
              disabled={disabled}
              data-testid={`openrouter-number-${key}`}
            />
            <p className="text-xs text-muted-foreground">{t(`performance.${key}.desc`)}</p>
          </div>
        ))}
      </div>

      {/* Injected body preview */}
      <div className="space-y-1.5">
        <Label className="text-sm">{t("preview.label")}</Label>
        <pre
          className="rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all"
          data-testid="openrouter-routing-preview"
        >
          {preview ? JSON.stringify({ provider: preview }, null, 2) : t("preview.empty")}
        </pre>
      </div>
    </div>
  );
}
