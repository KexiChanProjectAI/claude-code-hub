"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import type { ProviderType, ReasoningEffortOverrideRule } from "@/types/provider";
import {
  type ConditionalEditorRule,
  ConditionalOverrideRuleEditor,
  type ConditionalRuleEditorLabels,
  type ConditionalRuleEditorTestIds,
  type ConditionalRuleShapeSpec,
  fromConditionalEditorRule,
  toConditionalEditorRules,
} from "./conditional-override-rule-editor";

const CODEX_EFFORT_TARGETS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_EFFORT_TARGETS = ["low", "medium", "high", "xhigh", "max"] as const;

const RULE_SHAPE: ConditionalRuleShapeSpec = {
  originalValueKey: "originalReasoningEffort",
  targetKey: "overrideEffort",
};

const TEST_IDS: ConditionalRuleEditorTestIds = {
  target: "target-effort-",
  originalModelMatch: "original-model-match-",
  originalModelPattern: "original-model-pattern-",
  executionModelMatch: "execution-model-match-",
  executionModelPattern: "execution-model-pattern-",
  originalValueMode: "effort-mode-",
  originalValue: "original-effort-value-",
};

interface ReasoningEffortRuleEditorProps {
  rules: ReasoningEffortOverrideRule[] | null;
  onChange: (rules: ReasoningEffortOverrideRule[] | null) => void;
  providerType: ProviderType;
  disabled?: boolean;
}

export function ReasoningEffortRuleEditor({
  rules,
  onChange,
  providerType,
  disabled = false,
}: ReasoningEffortRuleEditorProps) {
  const t = useTranslations("settings.providers.form");
  const prefix = "sections.routing.effortRules";

  const validTargets =
    providerType === "codex" || providerType === "openai-compatible"
      ? CODEX_EFFORT_TARGETS
      : CLAUDE_EFFORT_TARGETS;
  const targets = useMemo(
    () =>
      validTargets.map((effort) => ({
        value: effort,
        label: t(`${prefix}.effortValues.${effort}`),
      })),
    [validTargets, t]
  );

  const labels = useMemo<ConditionalRuleEditorLabels>(
    () => ({
      title: t(`${prefix}.title`),
      description: t(`${prefix}.description`),
      noRules: t(`${prefix}.noRules`),
      addRule: t(`${prefix}.addRule`),
      removeRule: t(`${prefix}.removeRule`),
      moveUp: t(`${prefix}.moveUp`),
      moveDown: t(`${prefix}.moveDown`),
      ruleLabel: (number) => t(`${prefix}.ruleLabel`, { number }),
      target: t(`${prefix}.targetEffort`),
      selectTarget: t(`${prefix}.selectTarget`),
      originalModelCondition: t(`${prefix}.originalModelCondition`),
      executionModelCondition: t(`${prefix}.executionModelCondition`),
      removeCondition: t(`${prefix}.removeCondition`),
      addCondition: t(`${prefix}.addCondition`),
      matchMode: (mode) => t(`${prefix}.matchModes.${mode}`),
      patternPlaceholder: t(`${prefix}.patternPlaceholder`),
      originalValueCondition: t(`${prefix}.originalEffortCondition`),
      originalValueMode: {
        any: t(`${prefix}.effortMode.any`),
        missing: t(`${prefix}.effortMode.missing`),
        specific: t(`${prefix}.effortMode.specific`),
      },
      originalValuePlaceholder: t(`${prefix}.originalEffortPlaceholder`),
      maxRulesReached: (max) => t(`${prefix}.maxRulesReached`, { max }),
    }),
    [t]
  );

  const editorRules = useMemo(() => toConditionalEditorRules(rules, RULE_SHAPE), [rules]);
  const handleChange = useCallback(
    (next: ConditionalEditorRule[]) => {
      onChange(
        next.map((rule) => {
          const domain = fromConditionalEditorRule(rule, RULE_SHAPE);
          // Reasoning targets are always strings; "" marks a target not chosen yet.
          return { ...domain, overrideEffort: rule.target ?? "" } as ReasoningEffortOverrideRule;
        })
      );
    },
    [onChange]
  );

  return (
    <ConditionalOverrideRuleEditor
      rules={editorRules}
      onChange={handleChange}
      targets={targets}
      labels={labels}
      testIds={TEST_IDS}
      disabled={disabled}
    />
  );
}
