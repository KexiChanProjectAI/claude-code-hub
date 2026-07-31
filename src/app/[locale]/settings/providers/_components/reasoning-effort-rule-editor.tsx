"use client";

import { ChevronDown, ChevronUp, GripVertical, Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  ProviderModelRedirectMatchType,
  ProviderType,
  ReasoningEffortOverrideModelPredicate,
  ReasoningEffortOverrideRule,
  ReasoningEffortOverrideRuleWhen,
} from "@/types/provider";

const MAX_RULES = 50;

const MATCH_MODES: ProviderModelRedirectMatchType[] = [
  "exact",
  "prefix",
  "suffix",
  "contains",
  "regex",
];

const CODEX_EFFORT_TARGETS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const CLAUDE_EFFORT_TARGETS = ["low", "medium", "high", "xhigh", "max"] as const;

interface ReasoningEffortRuleEditorProps {
  rules: ReasoningEffortOverrideRule[] | null;
  onChange: (rules: ReasoningEffortOverrideRule[] | null) => void;
  providerType: ProviderType;
  disabled?: boolean;
}

function createEmptyRule(): ReasoningEffortOverrideRule {
  return { when: {}, overrideEffort: "" };
}

function isRuleValid(rule: ReasoningEffortOverrideRule, validTargets: readonly string[]): boolean {
  if (!rule.overrideEffort || !validTargets.includes(rule.overrideEffort)) return false;
  if (rule.when.originalModel) {
    if (!rule.when.originalModel.pattern) return false;
  }
  if (rule.when.executionModel) {
    if (!rule.when.executionModel.pattern) return false;
  }
  return true;
}

export function ReasoningEffortRuleEditor({
  rules,
  onChange,
  providerType,
  disabled = false,
}: ReasoningEffortRuleEditorProps) {
  const t = useTranslations("settings.providers.form");

  const isCodex = providerType === "codex";
  const validTargets = isCodex ? CODEX_EFFORT_TARGETS : CLAUDE_EFFORT_TARGETS;

  const displayRules = useMemo(() => rules ?? [], [rules]);

  const handleAddRule = useCallback(() => {
    if (displayRules.length >= MAX_RULES) return;
    const next = [...displayRules, createEmptyRule()];
    onChange(next);
  }, [displayRules, onChange]);

  const handleRemoveRule = useCallback(
    (index: number) => {
      const next = displayRules.filter((_, i) => i !== index);
      onChange(next.length > 0 ? next : []);
    },
    [displayRules, onChange]
  );

  const handleMoveRule = useCallback(
    (index: number, direction: "up" | "down") => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= displayRules.length) return;
      const next = [...displayRules];
      [next[index], next[target]] = [next[target], next[index]];
      onChange(next);
    },
    [displayRules, onChange]
  );

  const handleRuleChange = useCallback(
    (index: number, updated: ReasoningEffortOverrideRule) => {
      const next = [...displayRules];
      next[index] = updated;
      onChange(next);
    },
    [displayRules, onChange]
  );

  const handleToggleOriginalModel = useCallback(
    (index: number, enabled: boolean) => {
      const rule = displayRules[index];
      if (!rule) return;
      const when = { ...rule.when } as Record<string, unknown>;
      if (enabled) {
        when.originalModel = { matchType: "exact", pattern: "" };
      } else {
        delete when.originalModel;
      }
      handleRuleChange(index, { ...rule, when: when as ReasoningEffortOverrideRuleWhen });
    },
    [displayRules, handleRuleChange]
  );

  const handleToggleExecutionModel = useCallback(
    (index: number, enabled: boolean) => {
      const rule = displayRules[index];
      if (!rule) return;
      const when = { ...rule.when } as Record<string, unknown>;
      if (enabled) {
        when.executionModel = { matchType: "exact", pattern: "" };
      } else {
        delete when.executionModel;
      }
      handleRuleChange(index, { ...rule, when: when as ReasoningEffortOverrideRuleWhen });
    },
    [displayRules, handleRuleChange]
  );

  const handleOriginalModelChange = useCallback(
    (index: number, field: "matchType" | "pattern", value: string) => {
      const rule = displayRules[index];
      if (!rule?.when.originalModel) return;
      const predicate: ReasoningEffortOverrideModelPredicate = {
        ...rule.when.originalModel,
        [field]: value,
      };
      handleRuleChange(index, {
        ...rule,
        when: { ...rule.when, originalModel: predicate },
      });
    },
    [displayRules, handleRuleChange]
  );

  const handleExecutionModelChange = useCallback(
    (index: number, field: "matchType" | "pattern", value: string) => {
      const rule = displayRules[index];
      if (!rule?.when.executionModel) return;
      const predicate: ReasoningEffortOverrideModelPredicate = {
        ...rule.when.executionModel,
        [field]: value,
      };
      handleRuleChange(index, {
        ...rule,
        when: { ...rule.when, executionModel: predicate },
      });
    },
    [displayRules, handleRuleChange]
  );

  const handleOriginalEffortMode = useCallback(
    (index: number, mode: "any" | "missing" | "specific", value?: string) => {
      const rule = displayRules[index];
      if (!rule) return;
      const when = { ...rule.when } as Record<string, unknown>;
      if (mode === "any") {
        delete when.originalReasoningEffort;
      } else if (mode === "missing") {
        when.originalReasoningEffort = null;
      } else {
        when.originalReasoningEffort = value ?? "";
      }
      handleRuleChange(index, { ...rule, when: when as ReasoningEffortOverrideRuleWhen });
    },
    [displayRules, handleRuleChange]
  );

  const handleTargetEffortChange = useCallback(
    (index: number, effort: string) => {
      const rule = displayRules[index];
      if (!rule) return;
      handleRuleChange(index, { ...rule, overrideEffort: effort });
    },
    [displayRules, handleRuleChange]
  );

  const canAddMore = displayRules.length < MAX_RULES;

  return (
    <TooltipProvider>
      <div className="space-y-3" role="group" aria-label={t("sections.routing.effortRules.title")}>
        <p className="text-xs text-muted-foreground">
          {t("sections.routing.effortRules.description")}
        </p>

        {displayRules.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            {t("sections.routing.effortRules.noRules")}
          </p>
        )}

        {displayRules.map((rule, index) => (
          <RuleRow
            key={index}
            rule={rule}
            index={index}
            total={displayRules.length}
            validTargets={validTargets}
            disabled={disabled}
            onRemove={handleRemoveRule}
            onMoveUp={() => handleMoveRule(index, "up")}
            onMoveDown={() => handleMoveRule(index, "down")}
            onToggleOriginalModel={handleToggleOriginalModel}
            onToggleExecutionModel={handleToggleExecutionModel}
            onOriginalModelChange={handleOriginalModelChange}
            onExecutionModelChange={handleExecutionModelChange}
            onOriginalEffortMode={handleOriginalEffortMode}
            onTargetEffortChange={handleTargetEffortChange}
          />
        ))}

        {canAddMore && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddRule}
            disabled={disabled}
            className="w-full"
          >
            <Plus className="h-4 w-4 mr-1" />
            {t("sections.routing.effortRules.addRule")}
          </Button>
        )}

        {displayRules.length >= MAX_RULES && (
          <p className="text-xs text-amber-600">
            {t("sections.routing.effortRules.maxRulesReached", { max: MAX_RULES })}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

interface RuleRowProps {
  rule: ReasoningEffortOverrideRule;
  index: number;
  total: number;
  validTargets: readonly string[];
  disabled: boolean;
  onRemove: (index: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleOriginalModel: (index: number, enabled: boolean) => void;
  onToggleExecutionModel: (index: number, enabled: boolean) => void;
  onOriginalModelChange: (index: number, field: "matchType" | "pattern", value: string) => void;
  onExecutionModelChange: (index: number, field: "matchType" | "pattern", value: string) => void;
  onOriginalEffortMode: (
    index: number,
    mode: "any" | "missing" | "specific",
    value?: string
  ) => void;
  onTargetEffortChange: (index: number, effort: string) => void;
}

function RuleRow({
  rule,
  index,
  total,
  validTargets,
  disabled,
  onRemove,
  onMoveUp,
  onMoveDown,
  onToggleOriginalModel,
  onToggleExecutionModel,
  onOriginalModelChange,
  onExecutionModelChange,
  onOriginalEffortMode,
  onTargetEffortChange,
}: RuleRowProps) {
  const t = useTranslations("settings.providers.form");

  const hasOriginalModel = rule.when.originalModel != null;
  const hasExecutionModel = rule.when.executionModel != null;

  // Determine original effort mode
  const effortMode: "any" | "missing" | "specific" = (() => {
    if (!Object.hasOwn(rule.when, "originalReasoningEffort")) return "any";
    if (rule.when.originalReasoningEffort === null) return "missing";
    return "specific";
  })();

  const isRuleComplete = isRuleValid(rule, validTargets);

  return (
    <div
      className={`border rounded-lg p-3 space-y-2 ${
        isRuleComplete ? "border-primary/30 bg-primary/5" : "border-border"
      }`}
      role="listitem"
      aria-label={t("sections.routing.effortRules.ruleLabel", { number: index + 1 })}
    >
      {/* Header row: order controls + target effort */}
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onMoveUp}
                disabled={disabled || index === 0}
                aria-label={t("sections.routing.effortRules.moveUp")}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sections.routing.effortRules.moveUp")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onMoveDown}
                disabled={disabled || index === total - 1}
                aria-label={t("sections.routing.effortRules.moveDown")}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sections.routing.effortRules.moveDown")}</TooltipContent>
          </Tooltip>
        </div>

        <span className="text-xs font-mono text-muted-foreground w-5 text-center shrink-0">
          {index + 1}
        </span>

        <GripVertical className="h-4 w-4 text-muted-foreground/50 shrink-0" />

        <div className="flex-1 min-w-0">
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t("sections.routing.effortRules.targetEffort")}
          </label>
          <Select
            value={rule.overrideEffort}
            onValueChange={(val) => onTargetEffortChange(index, val)}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs" data-testid={`target-effort-${index}`}>
              <SelectValue placeholder={t("sections.routing.effortRules.selectTarget")} />
            </SelectTrigger>
            <SelectContent>
              {validTargets.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {t(`sections.routing.effortRules.effortValues.${effort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
          onClick={() => onRemove(index)}
          disabled={disabled}
          aria-label={t("sections.routing.effortRules.removeRule")}
        >
          <Minus className="h-4 w-4" />
        </Button>
      </div>

      {/* Original model condition */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            {t("sections.routing.effortRules.originalModelCondition")}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 text-xs px-1.5"
            onClick={() => onToggleOriginalModel(index, !hasOriginalModel)}
            disabled={disabled}
          >
            {hasOriginalModel
              ? t("sections.routing.effortRules.removeCondition")
              : t("sections.routing.effortRules.addCondition")}
          </Button>
        </div>
        {hasOriginalModel && (
          <div className="flex items-center gap-2 ml-2">
            <Select
              value={rule.when.originalModel?.matchType ?? "exact"}
              onValueChange={(val) => onOriginalModelChange(index, "matchType", val)}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-7 w-28 text-xs"
                data-testid={`original-model-match-${index}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`sections.routing.effortRules.matchModes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={rule.when.originalModel?.pattern ?? ""}
              onChange={(e) => onOriginalModelChange(index, "pattern", e.target.value)}
              placeholder={t("sections.routing.effortRules.patternPlaceholder")}
              disabled={disabled}
              className="h-7 text-xs flex-1"
              data-testid={`original-model-pattern-${index}`}
            />
          </div>
        )}
      </div>

      {/* Execution model condition */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            {t("sections.routing.effortRules.executionModelCondition")}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 text-xs px-1.5"
            onClick={() => onToggleExecutionModel(index, !hasExecutionModel)}
            disabled={disabled}
          >
            {hasExecutionModel
              ? t("sections.routing.effortRules.removeCondition")
              : t("sections.routing.effortRules.addCondition")}
          </Button>
        </div>
        {hasExecutionModel && (
          <div className="flex items-center gap-2 ml-2">
            <Select
              value={rule.when.executionModel?.matchType ?? "exact"}
              onValueChange={(val) => onExecutionModelChange(index, "matchType", val)}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-7 w-28 text-xs"
                data-testid={`execution-model-match-${index}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`sections.routing.effortRules.matchModes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={rule.when.executionModel?.pattern ?? ""}
              onChange={(e) => onExecutionModelChange(index, "pattern", e.target.value)}
              placeholder={t("sections.routing.effortRules.patternPlaceholder")}
              disabled={disabled}
              className="h-7 text-xs flex-1"
              data-testid={`execution-model-pattern-${index}`}
            />
          </div>
        )}
      </div>

      {/* Original effort mode */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground block">
          {t("sections.routing.effortRules.originalEffortCondition")}
        </label>
        <div className="flex items-center gap-2 ml-2">
          <Select
            value={effortMode}
            onValueChange={(val) =>
              onOriginalEffortMode(index, val as "any" | "missing" | "specific")
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-7 w-28 text-xs" data-testid={`effort-mode-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">
                {t("sections.routing.effortRules.effortMode.any")}
              </SelectItem>
              <SelectItem value="missing">
                {t("sections.routing.effortRules.effortMode.missing")}
              </SelectItem>
              <SelectItem value="specific">
                {t("sections.routing.effortRules.effortMode.specific")}
              </SelectItem>
            </SelectContent>
          </Select>
          {effortMode === "specific" && (
            <Input
              value={
                typeof rule.when.originalReasoningEffort === "string"
                  ? rule.when.originalReasoningEffort
                  : ""
              }
              onChange={(e) => onOriginalEffortMode(index, "specific", e.target.value)}
              placeholder={t("sections.routing.effortRules.originalEffortPlaceholder")}
              disabled={disabled}
              className="h-7 text-xs flex-1"
              data-testid={`original-effort-value-${index}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
