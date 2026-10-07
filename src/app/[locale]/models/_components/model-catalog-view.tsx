"use client";

import { Check, Copy, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ModelVendorIcon } from "@/components/customs/model-vendor-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CatalogModel, ModelCatalog } from "@/lib/model-catalog/types";
import { copyToClipboard } from "@/lib/utils/clipboard";

const CATALOG_PATH = "/v1/models/catalog";

type CapabilityKey = keyof NonNullable<CatalogModel["capabilities"]>;
const CAPABILITY_KEYS: CapabilityKey[] = [
  "vision",
  "functionCalling",
  "reasoning",
  "pdfInput",
  "promptCaching",
];

function CopyLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label={label}
        onClick={async () => {
          if (await copyToClipboard(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

interface ModelCatalogViewProps {
  catalog: ModelCatalog;
  origin: string | null;
}

export function ModelCatalogView({ catalog, origin }: ModelCatalogViewProps) {
  const t = useTranslations("modelCatalog");
  const format = useFormatter();
  const [query, setQuery] = useState("");

  const modelsById = useMemo(
    () => new Map(catalog.models.map((model) => [model.id, model])),
    [catalog.models]
  );

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog.models;
    return catalog.models.filter((model) =>
      [model.id, model.displayName, model.vendorName ?? "", ...model.protocols].some((value) =>
        value.toLowerCase().includes(needle)
      )
    );
  }, [catalog.models, query]);

  const visibleIds = useMemo(
    () => new Set(filteredModels.map((model) => model.id)),
    [filteredModels]
  );

  const formatTokens = (value: number | null) =>
    value === null ? "-" : format.number(value, { notation: "compact" });
  const formatPrice = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "-"
      : format.number(value, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

  const base = origin ?? "";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("machineReadable.title")}</CardTitle>
          <CardDescription className="text-xs">{t("machineReadable.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <CopyLine value={`${base}${CATALOG_PATH}`} label={t("machineReadable.copy")} />
          <CopyLine value={`${base}${CATALOG_PATH}?format=md`} label={t("machineReadable.copy")} />
          <p className="text-xs text-muted-foreground">
            {t("generatedAt", {
              time: format.dateTime(new Date(catalog.generatedAt), {
                dateStyle: "medium",
                timeStyle: "medium",
              }),
            })}
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="byModel">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList>
            <TabsTrigger value="byModel">
              {t("tabs.byModel")} ({catalog.models.length})
            </TabsTrigger>
            <TabsTrigger value="byProtocol">{t("tabs.byProtocol")}</TabsTrigger>
          </TabsList>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="h-9 pl-8 text-sm"
            />
          </div>
        </div>

        <TabsContent value="byModel" className="mt-4">
          <p className="mb-2 text-xs text-muted-foreground">{t("priceUnit")}</p>
          {filteredModels.length === 0 ? (
            <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.model")}</TableHead>
                    <TableHead>{t("columns.protocols")}</TableHead>
                    <TableHead className="text-right">{t("columns.contextWindow")}</TableHead>
                    <TableHead className="text-right">{t("columns.maxOutput")}</TableHead>
                    <TableHead className="text-right">{t("columns.inputPrice")}</TableHead>
                    <TableHead className="text-right">{t("columns.outputPrice")}</TableHead>
                    <TableHead className="text-right">{t("columns.cacheRead")}</TableHead>
                    <TableHead className="text-right">{t("columns.cacheWrite")}</TableHead>
                    <TableHead>{t("columns.capabilities")}</TableHead>
                    <TableHead>{t("columns.modalities")}</TableHead>
                    <TableHead>{t("columns.knowledgeCutoff")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredModels.map((model) => (
                    <TableRow key={model.id}>
                      <TableCell className="min-w-[220px]">
                        <div className="flex items-start gap-2">
                          <ModelVendorIcon
                            modelId={model.id}
                            vendor={model.vendor}
                            iconFile={model.vendorIcon}
                            iconMono={model.vendorIconMono}
                            className="mt-0.5 h-4 w-4 shrink-0"
                          />
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="break-all font-mono text-xs">{model.id}</span>
                              {model.deprecated && (
                                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                                  {t("status.deprecated")}
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {[
                                model.displayName !== model.id ? model.displayName : null,
                                model.vendorName,
                              ]
                                .filter(Boolean)
                                .join(" / ")}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {model.protocols.map((protocol) => (
                            <Badge
                              key={protocol}
                              variant="secondary"
                              className="font-mono text-[10px]"
                            >
                              {protocol}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(model.contextWindow)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(model.maxOutputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPrice(model.pricing?.input)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPrice(model.pricing?.output)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPrice(model.pricing?.cacheRead)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPrice(model.pricing?.cacheWrite)}
                      </TableCell>
                      <TableCell>
                        {model.capabilities ? (
                          <div className="flex flex-wrap gap-1">
                            {CAPABILITY_KEYS.filter((key) => model.capabilities?.[key]).map(
                              (key) => (
                                <Badge key={key} variant="outline" className="text-[10px]">
                                  {t(`capabilities.${key}`)}
                                </Badge>
                              )
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("noPriceData")}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {model.modalities ? (
                          <div className="space-y-0.5">
                            <div>
                              <span className="text-muted-foreground">
                                {t("modalities.input")}:{" "}
                              </span>
                              {model.modalities.input.join(", ") || "-"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                {t("modalities.output")}:{" "}
                              </span>
                              {model.modalities.output.join(", ") || "-"}
                            </div>
                          </div>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{model.knowledgeCutoff ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="byProtocol" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {catalog.protocols.map((protocol) => {
              const visible = protocol.models.filter((id) => visibleIds.has(id));
              return (
                <Card key={protocol.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-sm">{protocol.label}</CardTitle>
                      <Badge variant="secondary">
                        {t("protocolModelsCount", { count: protocol.models.length })}
                      </Badge>
                    </div>
                    <CardDescription className="space-x-2 font-mono text-xs">
                      <span>{protocol.id}</span>
                      <span>{protocol.endpointPath}</span>
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {visible.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("protocolEmpty")}</p>
                    ) : (
                      <ul className="flex flex-wrap gap-1.5">
                        {visible.map((id) => {
                          const model = modelsById.get(id);
                          return (
                            <li key={id}>
                              <Badge variant="outline" className="gap-1.5 font-mono text-[11px]">
                                <ModelVendorIcon
                                  modelId={id}
                                  vendor={model?.vendor}
                                  iconFile={model?.vendorIcon}
                                  iconMono={model?.vendorIconMono}
                                  className="h-3 w-3 shrink-0"
                                />
                                {id}
                              </Badge>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
