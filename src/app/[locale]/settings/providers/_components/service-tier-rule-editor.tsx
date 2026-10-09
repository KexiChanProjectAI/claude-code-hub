"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { CODEX_SERVICE_TIER_OVERRIDE_TARGETS } from "@/lib/service-tier-override";
import {
  type ConditionalEditorRule,
  ConditionalOverrideRuleEditor,
  type ConditionalRuleEditorLabels,
  type ConditionalRuleEditorTestIds,
  type ConditionalRuleShapeSpec,
  fromConditionalEditorRule,
  toConditionalEditorRules,
} from "./conditional-override-rule-editor";
import type { ServiceTierOverrideRuleDraft } from "./forms/provider-form/provider-form-types";

const RULE_SHAPE: ConditionalRuleShapeSpec = {
  originalValueKey: "originalServiceTier",
  targetKey: "overrideServiceTier",
};

const TEST_IDS: ConditionalRuleEditorTestIds = {
  target: "target-service-tier-",
  originalModelMatch: "service-tier-original-model-match-",
  originalModelPattern: "service-tier-original-model-pattern-",
  executionModelMatch: "service-tier-execution-model-match-",
  executionModelPattern: "service-tier-execution-model-pattern-",
  originalValueMode: "service-tier-mode-",
  originalValue: "original-service-tier-value-",
};

interface ServiceTierRuleEditorProps {
  rules: ServiceTierOverrideRuleDraft[] | null;
  onChange: (rules: ServiceTierOverrideRuleDraft[]) => void;
  disabled?: boolean;
}

export function ServiceTierRuleEditor({
  rules,
  onChange,
  disabled = false,
}: ServiceTierRuleEditorProps) {
  const t = useTranslations("settings.providers.form");
  const prefix = "sections.routing.serviceTierRules";

  const targets = useMemo(
    () => [
      ...CODEX_SERVICE_TIER_OVERRIDE_TARGETS.map((tier) => ({
        value: tier as string | null,
        label: t(`${prefix}.serviceTierValues.${tier}`),
      })),
      { value: null, label: t(`${prefix}.serviceTierValues.unset`) },
    ],
    [t]
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
      target: t(`${prefix}.targetServiceTier`),
      selectTarget: t(`${prefix}.selectTarget`),
      originalModelCondition: t(`${prefix}.originalModelCondition`),
      executionModelCondition: t(`${prefix}.executionModelCondition`),
      removeCondition: t(`${prefix}.removeCondition`),
      addCondition: t(`${prefix}.addCondition`),
      matchMode: (mode) => t(`${prefix}.matchModes.${mode}`),
      patternPlaceholder: t(`${prefix}.patternPlaceholder`),
      originalValueCondition: t(`${prefix}.originalServiceTierCondition`),
      originalValueMode: {
        any: t(`${prefix}.serviceTierMode.any`),
        missing: t(`${prefix}.serviceTierMode.missing`),
        specific: t(`${prefix}.serviceTierMode.specific`),
      },
      originalValuePlaceholder: t(`${prefix}.originalServiceTierPlaceholder`),
      maxRulesReached: (max) => t(`${prefix}.maxRulesReached`, { max }),
    }),
    [t]
  );

  const editorRules = useMemo(() => toConditionalEditorRules(rules, RULE_SHAPE), [rules]);
  const handleChange = useCallback(
    (next: ConditionalEditorRule[]) => {
      onChange(
        next.map(
          (rule) => fromConditionalEditorRule(rule, RULE_SHAPE) as ServiceTierOverrideRuleDraft
        )
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
