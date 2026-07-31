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

/** Find a Select mock and trigger its onValueChange callback */
function triggerSelectValue(container: HTMLElement, selectIndex: number, newValue: string) {
  const selectMocks = container.querySelectorAll("[data-testid='select-mock']");
  const select = selectMocks[selectIndex] as HTMLElement & {
    __onValueChange?: (v: string) => void;
  };
  if (!select) return;
  // Access onValueChange via the hidden input's ref
  const hiddenInput = select.querySelector("[data-onvaluechange]") as any;
  if (hiddenInput?.__onValueChange) {
    act(() => {
      hiddenInput.__onValueChange(newValue);
    });
  }
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

  // ---- Comprehensive coverage tests ----

  it("reorders rules when move up is clicked on second rule", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({ overrideEffort: "low" }),
      createRule({ overrideEffort: "high" }),
      createRule({ overrideEffort: "medium" }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const moveUpButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.moveUp"
    );
    // Click move up on second rule (index 1)
    act(() => {
      moveUpButtons[1].click();
    });
    expect(onChange).toHaveBeenCalledWith([
      { when: {}, overrideEffort: "high" },
      { when: {}, overrideEffort: "low" },
      { when: {}, overrideEffort: "medium" },
    ]);
    unmount();
  });

  it("move up on first rule is a no-op", () => {
    const onChange = vi.fn();
    const rules = [createRule({ overrideEffort: "low" }), createRule({ overrideEffort: "high" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const moveUpButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.moveUp"
    );
    act(() => {
      moveUpButtons[0].click();
    });
    // Should not be called - boundary check in handleMoveRule
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  });

  it("move down on last rule is a no-op", () => {
    const onChange = vi.fn();
    const rules = [createRule({ overrideEffort: "low" }), createRule({ overrideEffort: "high" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const moveDownButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.moveDown"
    );
    act(() => {
      moveDownButtons[1].click();
    });
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  });

  it("removes a non-first rule from multi-rule list", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({ overrideEffort: "low" }),
      createRule({ overrideEffort: "high" }),
      createRule({ overrideEffort: "medium" }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.getAttribute("aria-label") === "sections.routing.effortRules.removeRule"
    );
    act(() => {
      removeButtons[1].click();
    });
    expect(onChange).toHaveBeenCalledWith([
      { when: {}, overrideEffort: "low" },
      { when: {}, overrideEffort: "medium" },
    ]);
    unmount();
  });

  it("toggles execution model condition on and off", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    // Get all add/remove condition buttons
    const condButtons = Array.from(container.querySelectorAll("button")).filter((btn) => {
      const text = btn.textContent ?? "";
      return (
        text.includes("sections.routing.effortRules.addCondition") ||
        text.includes("sections.routing.effortRules.removeCondition")
      );
    });
    // Second button is execution model (index 1)
    act(() => {
      condButtons[1].click();
    });
    expect(onChange).toHaveBeenCalledWith([
      {
        when: { executionModel: { matchType: "exact", pattern: "" } },
        overrideEffort: "medium",
      },
    ]);
    unmount();
  });

  it("toggles execution model condition off when already enabled", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { executionModel: { matchType: "exact", pattern: "test" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const condButtons = Array.from(container.querySelectorAll("button")).filter((btn) => {
      const text = btn.textContent ?? "";
      return (
        text.includes("sections.routing.effortRules.addCondition") ||
        text.includes("sections.routing.effortRules.removeCondition")
      );
    });
    // Second pair is execution model (index 1)
    act(() => {
      condButtons[1].click();
    });
    // Should delete executionModel from when
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideEffort: "medium" }]);
    unmount();
  });

  it("changes original model matchType via Select", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { originalModel: { matchType: "exact", pattern: "test" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    // First select is target effort, second is original model matchType
    triggerSelectValue(container, 1, "prefix");
    expect(onChange).toHaveBeenCalledWith([
      {
        when: { originalModel: { matchType: "prefix", pattern: "test" } },
        overrideEffort: "medium",
      },
    ]);
    unmount();
  });

  it("changes original model pattern via Input", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { originalModel: { matchType: "exact", pattern: "" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const patternInput = container.querySelector(
      "[data-testid='original-model-pattern-0']"
    ) as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(patternInput, "claude-opus-4-6");
      patternInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith([
      {
        when: { originalModel: { matchType: "exact", pattern: "claude-opus-4-6" } },
        overrideEffort: "medium",
      },
    ]);
    unmount();
  });

  it("changes execution model matchType via Select", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { executionModel: { matchType: "exact", pattern: "test" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    // Selects: 0=target effort, 1=original model matchType (only if present), then execution model matchType
    // Since rule has executionModel but not originalModel, the Select order is:
    // 0=target effort, 1=execution model matchType
    triggerSelectValue(container, 1, "suffix");
    expect(onChange).toHaveBeenCalledWith([
      {
        when: { executionModel: { matchType: "suffix", pattern: "test" } },
        overrideEffort: "medium",
      },
    ]);
    unmount();
  });

  it("changes execution model pattern via Input", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { executionModel: { matchType: "exact", pattern: "" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const patternInput = container.querySelector(
      "[data-testid='execution-model-pattern-0']"
    ) as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(patternInput, "gpt-4o");
      patternInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith([
      {
        when: { executionModel: { matchType: "exact", pattern: "gpt-4o" } },
        overrideEffort: "medium",
      },
    ]);
    unmount();
  });

  it("sets original effort mode to missing (null)", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    // Selects: 0=target effort, 1=effort mode (next after model selects)
    triggerSelectValue(container, 1, "missing");
    expect(onChange).toHaveBeenCalledWith([
      { when: { originalReasoningEffort: null }, overrideEffort: "medium" },
    ]);
    unmount();
  });

  it("sets original effort mode to specific with a value", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    triggerSelectValue(container, 1, "specific");
    expect(onChange).toHaveBeenCalledWith([
      { when: { originalReasoningEffort: "" }, overrideEffort: "medium" },
    ]);
    unmount();
  });

  it("sets original effort mode to any (deletes key)", () => {
    const onChange = vi.fn();
    const rules = [createRule({ when: { originalReasoningEffort: null } })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    triggerSelectValue(container, 1, "any");
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideEffort: "medium" }]);
    unmount();
  });

  it("types a specific original effort value", () => {
    const onChange = vi.fn();
    const rules = [createRule({ when: { originalReasoningEffort: "" } })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const effortInput = container.querySelector(
      "[data-testid='original-effort-value-0']"
    ) as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(effortInput, "high");
      effortInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith([
      { when: { originalReasoningEffort: "high" }, overrideEffort: "medium" },
    ]);
    unmount();
  });

  it("changes target effort via Select", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    // First select is target effort
    triggerSelectValue(container, 0, "xhigh");
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideEffort: "xhigh" }]);
    unmount();
  });

  it("shows different target effort options for claude provider", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="claude" />
    );
    // Verify claude-specific options are rendered
    const options = container.querySelectorAll("[role='option']");
    const optionValues = Array.from(options).map((opt) => opt.getAttribute("data-value"));
    // Should include "max" (claude-specific) and NOT include "none" or "minimal" (codex-specific)
    expect(optionValues).toContain("max");
    expect(optionValues).not.toContain("none");
    expect(optionValues).not.toContain("minimal");
    unmount();
  });

  it("shows codex-specific target effort options for codex provider", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const options = container.querySelectorAll("[role='option']");
    const optionValues = Array.from(options).map((opt) => opt.getAttribute("data-value"));
    expect(optionValues).toContain("none");
    expect(optionValues).toContain("minimal");
    expect(optionValues).not.toContain("max");
    unmount();
  });

  it("marks rule with executionModel pattern valid as complete", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { executionModel: { matchType: "prefix", pattern: "gpt-" } },
        overrideEffort: "high",
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const ruleRow = container.querySelector("[role='listitem']");
    expect(ruleRow?.className).toContain("border-primary/30");
    unmount();
  });

  it("marks rule with empty executionModel pattern as invalid", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { executionModel: { matchType: "exact", pattern: "" } },
        overrideEffort: "high",
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const ruleRow = container.querySelector("[role='listitem']");
    expect(ruleRow?.className).not.toContain("border-primary/30");
    unmount();
  });

  it("marks rule with invalid target effort as incomplete", () => {
    const onChange = vi.fn();
    const rules = [createRule({ overrideEffort: "invalid-value" })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const ruleRow = container.querySelector("[role='listitem']");
    expect(ruleRow?.className).not.toContain("border-primary/30");
    unmount();
  });

  it("shows max-rules-reached message when at 50 rules", () => {
    const onChange = vi.fn();
    const rules = Array.from({ length: 50 }, () => createRule());
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    expect(container.textContent).toContain("sections.routing.effortRules.maxRulesReached");
    unmount();
  });

  it("disables buttons when disabled with full rule state", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: {
          originalModel: { matchType: "exact", pattern: "test" },
          executionModel: { matchType: "prefix", pattern: "gpt-" },
          originalReasoningEffort: "high",
        },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" disabled />
    );
    // All buttons should be disabled
    const allButtons = container.querySelectorAll("button");
    for (const btn of allButtons) {
      expect(btn).toHaveProperty("disabled", true);
    }
    unmount();
  });

  it("does not render original effort value input when mode is not specific", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const effortInput = container.querySelector("[data-testid='original-effort-value-0']");
    expect(effortInput).toBeNull();
    unmount();
  });

  it("renders original effort value input when mode is specific", () => {
    const onChange = vi.fn();
    const rules = [createRule({ when: { originalReasoningEffort: "medium" } })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const effortInput = container.querySelector("[data-testid='original-effort-value-0']");
    expect(effortInput).not.toBeNull();
    expect((effortInput as HTMLInputElement).value).toBe("medium");
    unmount();
  });

  it("renders original effort value input with empty string when value is empty string", () => {
    const onChange = vi.fn();
    const rules = [createRule({ when: { originalReasoningEffort: "" } })];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const effortInput = container.querySelector(
      "[data-testid='original-effort-value-0']"
    ) as HTMLInputElement;
    expect(effortInput).not.toBeNull();
    expect(effortInput.value).toBe("");
    unmount();
  });

  it("add button is disabled when disabled prop is true", () => {
    const onChange = vi.fn();
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={null} onChange={onChange} providerType="codex" disabled />
    );
    const addButtons = Array.from(container.querySelectorAll("button")).filter((btn) =>
      btn.textContent?.includes("sections.routing.effortRules.addRule")
    );
    if (addButtons.length > 0) {
      expect(addButtons[0]).toHaveProperty("disabled", true);
    }
    unmount();
  });

  it("toggle original model button is disabled when disabled", () => {
    const onChange = vi.fn();
    const rules = [createRule()];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" disabled />
    );
    const condButtons = Array.from(container.querySelectorAll("button")).filter((btn) => {
      const text = btn.textContent ?? "";
      return (
        text.includes("sections.routing.effortRules.addCondition") ||
        text.includes("sections.routing.effortRules.removeCondition")
      );
    });
    for (const btn of condButtons) {
      expect(btn).toHaveProperty("disabled", true);
    }
    unmount();
  });

  it("toggles original model off when already enabled", () => {
    const onChange = vi.fn();
    const rules = [
      createRule({
        when: { originalModel: { matchType: "exact", pattern: "test" } },
      }),
    ];
    const { container, unmount } = renderNode(
      <ReasoningEffortRuleEditor rules={rules} onChange={onChange} providerType="codex" />
    );
    const condButtons = Array.from(container.querySelectorAll("button")).filter((btn) => {
      const text = btn.textContent ?? "";
      return (
        text.includes("sections.routing.effortRules.addCondition") ||
        text.includes("sections.routing.effortRules.removeCondition")
      );
    });
    // First button is original model removeCondition
    act(() => {
      condButtons[0].click();
    });
    expect(onChange).toHaveBeenCalledWith([{ when: {}, overrideEffort: "medium" }]);
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
