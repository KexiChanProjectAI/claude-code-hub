/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecialSetting } from "@/types/special-settings";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/app/[locale]/dashboard/_components/ip-details-dialog", () => ({
  IpDetailsDialog: () => null,
}));

vi.mock("@/app/[locale]/dashboard/_components/ip-display-trigger", () => ({
  IpDisplayTrigger: () => null,
}));

vi.mock("@/components/customs/anthropic-effort-badge", () => ({
  AnthropicEffortBadge: ({ label }: { label: string }) => (
    <span data-testid="anthropic-effort-badge">{label}</span>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/tooltip", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Tooltip: passthrough,
    TooltipContent: passthrough,
    TooltipProvider: passthrough,
    TooltipTrigger: passthrough,
  };
});

vi.mock("@/app/[locale]/dashboard/logs/_components/fake200-retry-tooltip", () => ({
  Fake200RetryTooltip: () => null,
}));

const specialSettings: SpecialSetting[] = [
  {
    type: "anthropic_effort",
    scope: "request",
    hit: true,
    effort: "medium",
  },
  {
    type: "provider_parameter_override",
    scope: "provider",
    providerId: 1,
    providerName: "anthropic",
    providerType: "claude",
    hit: true,
    changed: true,
    changes: [{ path: "output_config.effort", before: "medium", after: "high", changed: true }],
    ruleEvaluation: { shouldOverride: true, overriddenEffort: "high", matchedIndex: 0 },
  },
];

describe("SummaryTab effort audit display", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders original and overridden effort from compatible changes", async () => {
    const { SummaryTab } = await import(
      "@/app/[locale]/dashboard/logs/_components/error-details-dialog/components/SummaryTab"
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <SummaryTab
          statusCode={200}
          errorMessage={null}
          providerChain={null}
          sessionId={null}
          specialSettings={specialSettings}
          hasMessages={false}
          checkingMessages={false}
        />
      );
    });

    expect(container.querySelectorAll('[data-testid="anthropic-effort-badge"]')).toHaveLength(2);
    expect(container.textContent).toContain("medium");
    expect(container.textContent).toContain("high");

    act(() => root.unmount());
    container.remove();
  });
});
