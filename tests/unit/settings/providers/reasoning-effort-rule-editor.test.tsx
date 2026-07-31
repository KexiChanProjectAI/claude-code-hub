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
  Select: ({ children, value }: any) => <div data-value={value}>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
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
import { ReasoningEffortRuleEditor } from "@/app/[locale]/settings/providers/_components/reasoning-effort-rule-editor";
import type { ReasoningEffortOverrideRule } from "@/types/provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function createRule(overrides?: Partial<ReasoningEffortOverrideRule>): ReasoningEffortOverrideRule {
  return {
    when: {},
    overrideEffort: "medium",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ReasoningEffortRuleEditor", () => {
  it("shows no-rules message when rules is null", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={null} onChange={onChange} providerType="codex" />
    );
    expect(container.textContent).toContain("sections.routing.effortRules.noRules");
    unmount();
  });

  it("shows no-rules message when rules is empty array", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={[]} onChange={onChange} providerType="codex" />
    );
    expect(container.textContent).toContain("sections.routing.effortRules.noRules");
    unmount();
  });

  it("renders rule rows when rules are provided", () => {
    const onChange = vi.fn();
    const rules = [createRule(), createRule({ overrideEffort: "high" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const items = container.querySelectorAll("[role='listitem']");
    expect(items.length).toBe(2);
    unmount();
  });

  it("calls onChange with new array when add rule is clicked", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={null} onChange={onChange} providerType="codex" />
    );
    const addButtons = Array.from(container.querySelectorAll("button")).filter((btn) =>
      btn.textContent?.includes("sections.routing.effortRules.addRule")
    );
    if (addButtons.length > 0) {
      act(() => {
        addButtons[0].click();
      });
      expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideEffort: "" }]);
    }
    unmount();
  });

  it("calls onChange with empty array when last rule is removed", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.removeRule"
    );
    if (removeButtons.length > 0) {
      act(() => {
        removeButtons[0].click();
      });
      expect(onChange).toHaveBeenCalledWith([]);
    }
    unmount();
  });

  it("reorders rules when move down is clicked on first rule", () => {
    const onChange = vi.fn();
    const rules = [createRule({ overrideEffort: "low" }), createRule({ overrideEffort: "high" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const moveDownButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.moveDown"
    );
    if (moveDownButtons.length > 0) {
      act(() => {
        moveDownButtons[0].click();
      });
      expect(onChange).toHaveBeenCalledWith([
        { when: {}, overrideEffort: "high" },
        { when: {}, overrideEffort: "low" },
      ]);
    }
    unmount();
  });

  it("does not allow adding beyond 50 rules", () => {
    const onChange = vi.fn();
    const rules = Array.from({ length: 50 }, () => createRule());
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const addButtons = Array.from(container.querySelectorAll("button")).filter((btn) =>
      btn.textContent?.includes("sections.routing.effortRules.addRule")
    );
    expect(addButtons.length).toBe(0);
    unmount();
  });

  it("disables all controls when disabled prop is true", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" disabled />
    );
    const allButtons = container.querySelectorAll("button");
    for (const btn of allButtons) {
      expect(btn).toHaveProperty("disabled", true);
    }
    unmount();
  });

  it("allows toggling original model condition", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const addCondButtons = Array.from(container.querySelectorAll("button")).filter((btn) =>
      btn.textContent?.includes("sections.routing.effortRules.addCondition")
    );
    if (addCondButtons.length > 0) {
      act(() => {
        addCondButtons[0].click();
      });
      expect(onChange).toHaveBeenCalledWith([
        {
          when: { originalModel: { matchType: "exact", pattern: "" } },
          overrideEffort: "medium",
        },
      ]);
    }
    unmount();
  });

  it("marks valid rules with complete styling", () => {
    const onChange = vi.fn();
    const rules = [createRule({ overrideEffort: "high" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const ruleRow = container.querySelector("[role='listitem']");
    expect(ruleRow?.className).toContain("border-primary/30");
    unmount();
  });

  it("validates that rules with empty pattern are invalid", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { originalModel: { matchType: "exact", pattern: "" } },
        overrideEffort: "medium",
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const ruleRow = container.querySelector("[role='listitem']");
    expect(ruleRow?.className).not.toContain("border-primary/30");
    unmount();
  });
});

describe("ReasoningEffortRuleEditor - five-locale key resolution", () => {
  it("resolves all required i18n keys for the rule editor in all 5 locales", () => {
    const requiredKeys = [
      "routing.effortRules.title",
      "routing.effortRules.description",
      "routing.effortRules.noRules",
      "routing.effortRules.addRule",
      "routing.effortRules.removeRule",
      "routing.effortRules.moveUp",
      "routing.effortRules.moveDown",
      "routing.effortRules.ruleLabel",
      "routing.effortRules.targetEffort",
      "routing.effortRules.selectTarget",
      "routing.effortRules.originalModelCondition",
      "routing.effortRules.executionModelCondition",
      "routing.effortRules.removeCondition",
      "routing.effortRules.addCondition",
      "routing.effortRules.matchModes.exact",
      "routing.effortRules.matchModes.prefix",
      "routing.effortRules.matchModes.suffix",
      "routing.effortRules.matchModes.contains",
      "routing.effortRules.matchModes.regex",
      "routing.effortRules.patternPlaceholder",
      "routing.effortRules.originalEffortCondition",
      "routing.effortRules.effortMode.any",
      "routing.effortRules.effortMode.missing",
      "routing.effortRules.effortMode.specific",
      "routing.effortRules.originalEffortPlaceholder",
      "routing.effortRules.maxRulesReached",
      "routing.effortRules.effortValues.none",
      "routing.effortRules.effortValues.minimal",
      "routing.effortRules.effortValues.low",
      "routing.effortRules.effortValues.medium",
      "routing.effortRules.effortValues.high",
      "routing.effortRules.effortValues.xhigh",
      "routing.effortRules.effortValues.max",
    ];

    const locales = ["en", "ja", "ru", "zh-CN", "zh-TW"];
    for (const locale of locales) {
      const sections = require(
        `../../../../messages/${locale}/settings/providers/form/sections.json`
      );
      for (const key of requiredKeys) {
        const parts = key.split(".");
        let value: unknown = sections;
        for (const part of parts) {
          value = (value as Record<string, unknown>)?.[part];
        }
        expect(value, `Missing key "${key}" in locale "${locale}"`).toBeDefined();
      }
    }
  });
});
