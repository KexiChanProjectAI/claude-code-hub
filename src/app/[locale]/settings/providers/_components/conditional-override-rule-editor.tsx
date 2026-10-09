"use client";

import { ChevronDown, ChevronUp, GripVertical, Minus, Plus } from "lucide-react";
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
  ReasoningEffortOverrideModelPredicate,
} from "@/types/provider";

export const CONDITIONAL_RULE_MAX_RULES = 50;

/** Select cannot hold null or "", so a null ("unset") target is represented by this sentinel. */
export const CONDITIONAL_RULE_UNSET_TARGET = "__unset__";

const MATCH_MODES: ProviderModelRedirectMatchType[] = [
  "exact",
  "prefix",
  "suffix",
  "contains",
  "regex",
];

type OriginalValueMode = "any" | "missing" | "specific";

/**
 * Neutral rule shape used by the editor.
 * - when.originalValue: omitted = any, null = client sent none, string = exact value
 * - target: "" = not chosen yet, null = "unset" target, string = concrete target
 */
export type ConditionalEditorRuleWhen = {
  readonly originalModel?: ReasoningEffortOverrideModelPredicate;
  readonly executionModel?: ReasoningEffortOverrideModelPredicate;
  readonly originalValue?: string | null;
};

export type ConditionalEditorRule = {
  readonly when: ConditionalEditorRuleWhen;
  readonly target: string | null;
};

export type ConditionalRuleShapeSpec = {
  readonly originalValueKey: string;
  readonly targetKey: string;
};

export type ConditionalRuleEditorTarget = {
  readonly value: string | null;
  readonly label: string;
};

export type ConditionalRuleEditorLabels = {
  readonly title: string;
  readonly description: string;
  readonly noRules: string;
  readonly addRule: string;
  readonly removeRule: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly ruleLabel: (number: number) => string;
  readonly target: string;
  readonly selectTarget: string;
  readonly originalModelCondition: string;
  readonly executionModelCondition: string;
  readonly removeCondition: string;
  readonly addCondition: string;
  readonly matchMode: (mode: ProviderModelRedirectMatchType) => string;
  readonly patternPlaceholder: string;
  readonly originalValueCondition: string;
  readonly originalValueMode: Readonly<Record<OriginalValueMode, string>>;
  readonly originalValuePlaceholder: string;
  readonly maxRulesReached: (max: number) => string;
};

/** data-testid prefixes; the rule index is appended to each. */
export type ConditionalRuleEditorTestIds = {
  readonly target: string;
  readonly originalModelMatch: string;
  readonly originalModelPattern: string;
  readonly executionModelMatch: string;
  readonly executionModelPattern: string;
  readonly originalValueMode: string;
  readonly originalValue: string;
};

type DomainRule = { readonly when: Readonly<Record<string, unknown>> } & Readonly<
  Record<string, unknown>
>;

/** Convert domain rules (e.g. { when: { originalReasoningEffort }, overrideEffort }) to the editor shape. */
export function toConditionalEditorRules(
  rules: readonly DomainRule[] | null,
  spec: ConditionalRuleShapeSpec
): ConditionalEditorRule[] {
  return (rules ?? []).map((rule) => {
    const source = rule.when ?? {};
    const when: {
      originalModel?: ReasoningEffortOverrideModelPredicate;
      executionModel?: ReasoningEffortOverrideModelPredicate;
      originalValue?: string | null;
    } = {};
    if (source.originalModel) {
      when.originalModel = source.originalModel as ReasoningEffortOverrideModelPredicate;
    }
    if (source.executionModel) {
      when.executionModel = source.executionModel as ReasoningEffortOverrideModelPredicate;
    }
    if (Object.hasOwn(source, spec.originalValueKey)) {
      const value = source[spec.originalValueKey];
      when.originalValue = typeof value === "string" ? value : null;
    }
    const target = rule[spec.targetKey];
    return { when, target: target === null ? null : typeof target === "string" ? target : "" };
  });
}

/** Convert an editor rule back to the domain shape, keeping only the keys that are set. */
export function fromConditionalEditorRule(
  rule: ConditionalEditorRule,
  spec: ConditionalRuleShapeSpec
): Record<string, unknown> {
  const when: Record<string, unknown> = {};
  if (rule.when.originalModel) when.originalModel = rule.when.originalModel;
  if (rule.when.executionModel) when.executionModel = rule.when.executionModel;
  if (Object.hasOwn(rule.when, "originalValue")) {
    when[spec.originalValueKey] = rule.when.originalValue ?? null;
  }
  return { when, [spec.targetKey]: rule.target };
}

function toSelectValue(target: string | null): string {
  return target === null ? CONDITIONAL_RULE_UNSET_TARGET : target;
}

function fromSelectValue(value: string): string | null {
  return value === CONDITIONAL_RULE_UNSET_TARGET ? null : value;
}

export function isConditionalEditorRuleValid(
  rule: ConditionalEditorRule,
  targets: readonly ConditionalRuleEditorTarget[]
): boolean {
  if (rule.target === "" || !targets.some((option) => option.value === rule.target)) {
    return false;
  }
  if (rule.when.originalModel && !rule.when.originalModel.pattern) return false;
  if (rule.when.executionModel && !rule.when.executionModel.pattern) return false;
  return true;
}

interface ConditionalOverrideRuleEditorProps {
  rules: ConditionalEditorRule[];
  onChange: (rules: ConditionalEditorRule[]) => void;
  targets: readonly ConditionalRuleEditorTarget[];
  labels: ConditionalRuleEditorLabels;
  testIds: ConditionalRuleEditorTestIds;
  disabled?: boolean;
}

export function ConditionalOverrideRuleEditor({
  rules,
  onChange,
  targets,
  labels,
  testIds,
  disabled = false,
}: ConditionalOverrideRuleEditorProps) {
  const displayRules = useMemo(() => rules, [rules]);

  const updateRule = useCallback(
    (index: number, update: (rule: ConditionalEditorRule) => ConditionalEditorRule) => {
      const rule = displayRules[index];
      if (!rule) return;
      const next = [...displayRules];
      next[index] = update(rule);
      onChange(next);
    },
    [displayRules, onChange]
  );

  const handleAddRule = useCallback(() => {
    if (displayRules.length >= CONDITIONAL_RULE_MAX_RULES) return;
    onChange([...displayRules, { when: {}, target: "" }]);
  }, [displayRules, onChange]);

  const handleRemoveRule = useCallback(
    (index: number) => {
      onChange(displayRules.filter((_, i) => i !== index));
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

  const handleToggleModel = useCallback(
    (index: number, key: "originalModel" | "executionModel", enabled: boolean) => {
      updateRule(index, (rule) => {
        const when: Record<string, unknown> = { ...rule.when };
        if (enabled) {
          when[key] = { matchType: "exact", pattern: "" };
        } else {
          delete when[key];
        }
        return { ...rule, when: when as ConditionalEditorRuleWhen };
      });
    },
    [updateRule]
  );

  const handleModelChange = useCallback(
    (
      index: number,
      key: "originalModel" | "executionModel",
      field: "matchType" | "pattern",
      value: string
    ) => {
      updateRule(index, (rule) => {
        const predicate = rule.when[key];
        if (!predicate) return rule;
        return {
          ...rule,
          when: {
            ...rule.when,
            [key]: { ...predicate, [field]: value } as ReasoningEffortOverrideModelPredicate,
          },
        };
      });
    },
    [updateRule]
  );

  const handleOriginalValueMode = useCallback(
    (index: number, mode: OriginalValueMode, value?: string) => {
      updateRule(index, (rule) => {
        const when: Record<string, unknown> = { ...rule.when };
        if (mode === "any") {
          delete when.originalValue;
        } else if (mode === "missing") {
          when.originalValue = null;
        } else {
          when.originalValue = value ?? "";
        }
        return { ...rule, when: when as ConditionalEditorRuleWhen };
      });
    },
    [updateRule]
  );

  const handleTargetChange = useCallback(
    (index: number, value: string) => {
      updateRule(index, (rule) => ({ ...rule, target: fromSelectValue(value) }));
    },
    [updateRule]
  );

  const canAddMore = displayRules.length < CONDITIONAL_RULE_MAX_RULES;

  return (
    <TooltipProvider>
      <div className="space-y-3" role="group" aria-label={labels.title}>
        <p className="text-xs text-muted-foreground">{labels.description}</p>

        {displayRules.length === 0 && (
          <p className="text-sm text-muted-foreground italic">{labels.noRules}</p>
        )}

        {displayRules.map((rule, index) => (
          <RuleRow
            key={index}
            rule={rule}
            index={index}
            total={displayRules.length}
            targets={targets}
            labels={labels}
            testIds={testIds}
            disabled={disabled}
            onRemove={handleRemoveRule}
            onMoveUp={() => handleMoveRule(index, "up")}
            onMoveDown={() => handleMoveRule(index, "down")}
            onToggleModel={handleToggleModel}
            onModelChange={handleModelChange}
            onOriginalValueMode={handleOriginalValueMode}
            onTargetChange={handleTargetChange}
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
            {labels.addRule}
          </Button>
        )}

        {displayRules.length >= CONDITIONAL_RULE_MAX_RULES && (
          <p className="text-xs text-amber-600">
            {labels.maxRulesReached(CONDITIONAL_RULE_MAX_RULES)}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

interface RuleRowProps {
  rule: ConditionalEditorRule;
  index: number;
  total: number;
  targets: readonly ConditionalRuleEditorTarget[];
  labels: ConditionalRuleEditorLabels;
  testIds: ConditionalRuleEditorTestIds;
  disabled: boolean;
  onRemove: (index: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleModel: (index: number, key: "originalModel" | "executionModel", enabled: boolean) => void;
  onModelChange: (
    index: number,
    key: "originalModel" | "executionModel",
    field: "matchType" | "pattern",
    value: string
  ) => void;
  onOriginalValueMode: (index: number, mode: OriginalValueMode, value?: string) => void;
  onTargetChange: (index: number, value: string) => void;
}

function RuleRow({
  rule,
  index,
  total,
  targets,
  labels,
  testIds,
  disabled,
  onRemove,
  onMoveUp,
  onMoveDown,
  onToggleModel,
  onModelChange,
  onOriginalValueMode,
  onTargetChange,
}: RuleRowProps) {
  const originalValueMode: OriginalValueMode = !Object.hasOwn(rule.when, "originalValue")
    ? "any"
    : rule.when.originalValue === null
      ? "missing"
      : "specific";

  const isRuleComplete = isConditionalEditorRuleValid(rule, targets);

  return (
    <div
      className={`border rounded-lg p-3 space-y-2 ${
        isRuleComplete ? "border-primary/30 bg-primary/5" : "border-border"
      }`}
      role="listitem"
      aria-label={labels.ruleLabel(index + 1)}
    >
      {/* Header row: order controls + target */}
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
                aria-label={labels.moveUp}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{labels.moveUp}</TooltipContent>
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
                aria-label={labels.moveDown}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{labels.moveDown}</TooltipContent>
          </Tooltip>
        </div>

        <span className="text-xs font-mono text-muted-foreground w-5 text-center shrink-0">
          {index + 1}
        </span>

        <GripVertical className="h-4 w-4 text-muted-foreground/50 shrink-0" />

        <div className="flex-1 min-w-0">
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {labels.target}
          </label>
          <Select
            value={toSelectValue(rule.target)}
            onValueChange={(val) => onTargetChange(index, val)}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs" data-testid={`${testIds.target}${index}`}>
              <SelectValue placeholder={labels.selectTarget} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((option) => (
                <SelectItem key={toSelectValue(option.value)} value={toSelectValue(option.value)}>
                  {option.label}
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
          aria-label={labels.removeRule}
        >
          <Minus className="h-4 w-4" />
        </Button>
      </div>

      <ModelCondition
        conditionKey="originalModel"
        label={labels.originalModelCondition}
        predicate={rule.when.originalModel}
        index={index}
        labels={labels}
        matchTestId={`${testIds.originalModelMatch}${index}`}
        patternTestId={`${testIds.originalModelPattern}${index}`}
        disabled={disabled}
        onToggle={onToggleModel}
        onChange={onModelChange}
      />

      <ModelCondition
        conditionKey="executionModel"
        label={labels.executionModelCondition}
        predicate={rule.when.executionModel}
        index={index}
        labels={labels}
        matchTestId={`${testIds.executionModelMatch}${index}`}
        patternTestId={`${testIds.executionModelPattern}${index}`}
        disabled={disabled}
        onToggle={onToggleModel}
        onChange={onModelChange}
      />

      {/* Original client value condition */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground block">
          {labels.originalValueCondition}
        </label>
        <div className="flex items-center gap-2 ml-2">
          <Select
            value={originalValueMode}
            onValueChange={(val) => onOriginalValueMode(index, val as OriginalValueMode)}
            disabled={disabled}
          >
            <SelectTrigger
              className="h-7 w-28 text-xs"
              data-testid={`${testIds.originalValueMode}${index}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{labels.originalValueMode.any}</SelectItem>
              <SelectItem value="missing">{labels.originalValueMode.missing}</SelectItem>
              <SelectItem value="specific">{labels.originalValueMode.specific}</SelectItem>
            </SelectContent>
          </Select>
          {originalValueMode === "specific" && (
            <Input
              value={typeof rule.when.originalValue === "string" ? rule.when.originalValue : ""}
              onChange={(e) => onOriginalValueMode(index, "specific", e.target.value)}
              placeholder={labels.originalValuePlaceholder}
              disabled={disabled}
              className="h-7 text-xs flex-1"
              data-testid={`${testIds.originalValue}${index}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface ModelConditionProps {
  conditionKey: "originalModel" | "executionModel";
  label: string;
  predicate: ReasoningEffortOverrideModelPredicate | undefined;
  index: number;
  labels: ConditionalRuleEditorLabels;
  matchTestId: string;
  patternTestId: string;
  disabled: boolean;
  onToggle: RuleRowProps["onToggleModel"];
  onChange: RuleRowProps["onModelChange"];
}

function ModelCondition({
  conditionKey,
  label,
  predicate,
  index,
  labels,
  matchTestId,
  patternTestId,
  disabled,
  onToggle,
  onChange,
}: ModelConditionProps) {
  const enabled = predicate != null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">{label}</label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 text-xs px-1.5"
          onClick={() => onToggle(index, conditionKey, !enabled)}
          disabled={disabled}
        >
          {enabled ? labels.removeCondition : labels.addCondition}
        </Button>
      </div>
      {enabled && (
        <div className="flex items-center gap-2 ml-2">
          <Select
            value={predicate?.matchType ?? "exact"}
            onValueChange={(val) => onChange(index, conditionKey, "matchType", val)}
            disabled={disabled}
          >
            <SelectTrigger className="h-7 w-28 text-xs" data-testid={matchTestId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MATCH_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {labels.matchMode(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={predicate?.pattern ?? ""}
            onChange={(e) => onChange(index, conditionKey, "pattern", e.target.value)}
            placeholder={labels.patternPlaceholder}
            disabled={disabled}
            className="h-7 text-xs flex-1"
            data-testid={patternTestId}
          />
        </div>
      )}
    </div>
  );
}
