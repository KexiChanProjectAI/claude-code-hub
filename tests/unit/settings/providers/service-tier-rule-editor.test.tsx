/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key;
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{${k}}`, String(v));
      }
      return result;
    }
    return key;
  },
}));

vi.mock("lucide-react", () => {
  const stub = ({ className, ...rest }: any) => (
    <span data-testid="icon" className={className} {...rest} />
  );
  return {
    GripVertical: stub,
    Minus: stub,
    Plus: stub,
    ChevronDown: stub,
    ChevronUp: stub,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: any) => (
    <div
      data-value={value}
      data-testid="select-mock"
      data-disabled={disabled ? "true" : undefined}
      onClick={() => {
        /* noop */
      }}
    >
      {children}
      {/* Expose onValueChange via data attribute for testing */}
      <input
        type="hidden"
        data-onvaluechange="true"
        ref={(el: HTMLInputElement | null) => {
          if (el) {
            (el as any).__onValueChange = onValueChange;
          }
        }}
      />
    </div>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => (
    <div data-value={value} role="option">
      {children}
    </div>
  ),
  SelectTrigger: ({ children, className, ...rest }: any) => (
    <div className={className} {...rest}>
      {children}
    </div>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}));

import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  CONDITIONAL_RULE_UNSET_TARGET,
  fromConditionalEditorRule,
  isConditionalEditorRuleValid,
  toConditionalEditorRules,
} from "@/app/[locale]/settings/providers/_components/conditional-override-rule-editor";
import type { ServiceTierOverrideRuleDraft } from "@/app/[locale]/settings/providers/_components/forms/provider-form/provider-form-types";
import { ServiceTierRuleEditor } from "@/app/[locale]/settings/providers/_components/service-tier-rule-editor";

function renderNode(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function triggerSelectValue(container: HTMLElement, selectIndex: number, newValue: string) {
  const select = container.querySelectorAll("[data-testid='select-mock']")[selectIndex];
  const hiddenInput = select?.querySelector("[data-onvaluechange]") as any;
  if (hiddenInput?.__onValueChange) {
    act(() => {
      hiddenInput.__onValueChange(newValue);
    });
  }
}

function buttonsWithText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).filter((btn) =>
    btn.textContent?.includes(text)
  );
}

const PREFIX = "sections.routing.serviceTierRules";

describe("ServiceTierRuleEditor", () => {
  it("shows the no-rules message and adds an empty draft rule", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor rules={null} onChange={onChange} />
    );
    expect(container.textContent).toContain(`${PREFIX}.noRules`);

    act(() => {
      buttonsWithText(container, `${PREFIX}.addRule`)[0].click();
    });
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideServiceTier: "" }]);
    unmount();
  });

  it("offers the four tiers plus an unset option", () => {
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor
        rules={[{ when: {}, overrideServiceTier: "flex" }]}
        onChange={vi.fn()}
      />
    );
    const targetSelect = container.querySelectorAll("[data-testid='select-mock']")[0];
    const values = Array.from(targetSelect.querySelectorAll("[role='option']")).map((option) =>
      option.getAttribute("data-value")
    );
    expect(values).toEqual(["auto", "default", "flex", "priority", CONDITIONAL_RULE_UNSET_TARGET]);
    expect(targetSelect.getAttribute("data-value")).toBe("flex");
    expect(container.querySelector("[data-testid='target-service-tier-0']")).not.toBeNull();
    unmount();
  });

  it("maps the unset option to a null target and shows null as the sentinel", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor
        rules={[{ when: {}, overrideServiceTier: "priority" }]}
        onChange={onChange}
      />
    );
    triggerSelectValue(container, 0, CONDITIONAL_RULE_UNSET_TARGET);
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideServiceTier: null }]);
    unmount();

    const rendered = renderNode(
      <ServiceTierRuleEditor rules={[{ when: {}, overrideServiceTier: null }]} onChange={vi.fn()} />
    );
    const targetSelect = rendered.container.querySelectorAll("[data-testid='select-mock']")[0];
    expect(targetSelect.getAttribute("data-value")).toBe(CONDITIONAL_RULE_UNSET_TARGET);
    expect(rendered.container.querySelector("[role='listitem']")?.className).toContain(
      "border-primary/30"
    );
    rendered.unmount();
  });

  it("edits the original service tier condition as any / missing / specific", () => {
    const onChange = vi.fn();
    const rules: ServiceTierOverrideRuleDraft[] = [{ when: {}, overrideServiceTier: "flex" }];
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor rules={rules} onChange={onChange} />
    );
    // Select order: target (0), original value mode (1)
    triggerSelectValue(container, 1, "missing");
    expect(onChange).toHaveBeenLastCalledWith([
      { when: { originalServiceTier: null }, overrideServiceTier: "flex" },
    ]);
    triggerSelectValue(container, 1, "specific");
    expect(onChange).toHaveBeenLastCalledWith([
      { when: { originalServiceTier: "" }, overrideServiceTier: "flex" },
    ]);
    unmount();

    const specific = renderNode(
      <ServiceTierRuleEditor
        rules={[{ when: { originalServiceTier: "priority" }, overrideServiceTier: null }]}
        onChange={onChange}
      />
    );
    const input = specific.container.querySelector(
      "[data-testid='original-service-tier-value-0']"
    ) as HTMLInputElement;
    expect(input.value).toBe("priority");
    triggerSelectValue(specific.container, 1, "any");
    expect(onChange).toHaveBeenLastCalledWith([{ when: {}, overrideServiceTier: null }]);
    specific.unmount();
  });

  it("adds, edits and removes model conditions with service-tier test ids", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor
        rules={[
          {
            when: { executionModel: { matchType: "exact", pattern: "gpt-5" } },
            overrideServiceTier: "auto",
          },
        ]}
        onChange={onChange}
      />
    );
    expect(
      container.querySelector("[data-testid='service-tier-execution-model-pattern-0']")
    ).not.toBeNull();

    act(() => {
      buttonsWithText(container, `${PREFIX}.addCondition`)[0].click();
    });
    expect(onChange).toHaveBeenLastCalledWith([
      {
        when: {
          originalModel: { matchType: "exact", pattern: "" },
          executionModel: { matchType: "exact", pattern: "gpt-5" },
        },
        overrideServiceTier: "auto",
      },
    ]);

    // Select order: target (0), execution model match (1), original value mode (2)
    triggerSelectValue(container, 1, "prefix");
    expect(onChange).toHaveBeenLastCalledWith([
      {
        when: { executionModel: { matchType: "prefix", pattern: "gpt-5" } },
        overrideServiceTier: "auto",
      },
    ]);

    act(() => {
      buttonsWithText(container, `${PREFIX}.removeCondition`)[0].click();
    });
    expect(onChange).toHaveBeenLastCalledWith([{ when: {}, overrideServiceTier: "auto" }]);
    unmount();
  });

  it("reorders and removes rules", () => {
    const onChange = vi.fn();
    const rules: ServiceTierOverrideRuleDraft[] = [
      { when: {}, overrideServiceTier: "flex" },
      { when: {}, overrideServiceTier: null },
    ];
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor rules={rules} onChange={onChange} />
    );

    act(() => {
      (
        container.querySelectorAll(`button[aria-label='${PREFIX}.moveDown']`)[0] as HTMLElement
      ).click();
    });
    expect(onChange).toHaveBeenLastCalledWith([rules[1], rules[0]]);

    act(() => {
      (
        container.querySelectorAll(`button[aria-label='${PREFIX}.removeRule']`)[0] as HTMLElement
      ).click();
    });
    expect(onChange).toHaveBeenLastCalledWith([rules[1]]);
    unmount();
  });

  it("disables controls and hides the add button at 50 rules", () => {
    const rules = Array.from({ length: 50 }, () => ({
      when: {},
      overrideServiceTier: "flex" as const,
    }));
    const { container, unmount } = renderNode(
      <ServiceTierRuleEditor rules={rules} onChange={vi.fn()} disabled />
    );
    expect(buttonsWithText(container, `${PREFIX}.addRule`)).toHaveLength(0);
    expect(container.textContent).toContain(`${PREFIX}.maxRulesReached`);
    expect(
      Array.from(container.querySelectorAll("button")).every((button) => button.disabled)
    ).toBe(true);
    unmount();
  });
});

describe("conditional editor rule helpers", () => {
  const spec = { originalValueKey: "originalServiceTier", targetKey: "overrideServiceTier" };
  const targets = [
    { value: "flex", label: "flex" },
    { value: null, label: "unset" },
  ];

  it("round-trips domain rules without adding keys", () => {
    const domain = [
      {
        when: {
          originalModel: { matchType: "exact", pattern: "a" },
          executionModel: { matchType: "suffix", pattern: "b" },
          originalServiceTier: null,
        },
        overrideServiceTier: null,
      },
      { when: {}, overrideServiceTier: "flex" },
    ];
    const editor = toConditionalEditorRules(domain, spec);
    expect(editor[0].when).toHaveProperty("originalValue", null);
    expect(editor[1].when).not.toHaveProperty("originalValue");
    expect(editor.map((rule) => fromConditionalEditorRule(rule, spec))).toEqual(domain);
  });

  it("maps unknown targets to the not-chosen marker", () => {
    expect(toConditionalEditorRules([{ when: {}, overrideServiceTier: 3 }], spec)[0].target).toBe(
      ""
    );
    expect(toConditionalEditorRules(null, spec)).toEqual([]);
  });

  it("validates targets and model patterns", () => {
    expect(isConditionalEditorRuleValid({ when: {}, target: null }, targets)).toBe(true);
    expect(isConditionalEditorRuleValid({ when: {}, target: "" }, targets)).toBe(false);
    expect(isConditionalEditorRuleValid({ when: {}, target: "priority" }, targets)).toBe(false);
    expect(isConditionalEditorRuleValid({ when: {}, target: null }, [targets[0]])).toBe(false);
    expect(
      isConditionalEditorRuleValid(
        { when: { originalModel: { matchType: "exact", pattern: "" } }, target: "flex" },
        targets
      )
    ).toBe(false);
    expect(
      isConditionalEditorRuleValid(
        { when: { executionModel: { matchType: "exact", pattern: "" } }, target: "flex" },
        targets
      )
    ).toBe(false);
  });
});

describe("ServiceTierRuleEditor - five-locale key resolution", () => {
  it("resolves all required i18n keys in all 5 locales", () => {
    const requiredKeys = [
      "title",
      "description",
      "noRules",
      "addRule",
      "removeRule",
      "moveUp",
      "moveDown",
      "ruleLabel",
      "targetServiceTier",
      "selectTarget",
      "originalModelCondition",
      "executionModelCondition",
      "removeCondition",
      "addCondition",
      "matchModes.exact",
      "matchModes.prefix",
      "matchModes.suffix",
      "matchModes.contains",
      "matchModes.regex",
      "patternPlaceholder",
      "originalServiceTierCondition",
      "serviceTierMode.any",
      "serviceTierMode.missing",
      "serviceTierMode.specific",
      "originalServiceTierPlaceholder",
      "maxRulesReached",
      "serviceTierValues.auto",
      "serviceTierValues.default",
      "serviceTierValues.flex",
      "serviceTierValues.priority",
      "serviceTierValues.unset",
    ].map((key) => `routing.serviceTierRules.${key}`);

    for (const locale of ["en", "ja", "ru", "zh-CN", "zh-TW"]) {
      const sections = require(
        `../../../../messages/${locale}/settings/providers/form/sections.json`
      );
      for (const key of [...requiredKeys, "routing.codexOverrides.serviceTier.help"]) {
        let value: unknown = sections;
        for (const part of key.split(".")) {
          value = (value as Record<string, unknown>)?.[part];
        }
        expect(typeof value, `Missing key "${key}" in locale "${locale}"`).toBe("string");
      }
    }
  });
});
