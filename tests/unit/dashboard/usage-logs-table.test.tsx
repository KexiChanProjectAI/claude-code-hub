/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageLogsTable as UsageLogsTableForTest } from "@/app/[locale]/dashboard/logs/_components/usage-logs-table";
import type { UsageLogRow } from "@/repository/usage-logs";
import type { SpecialSetting } from "@/types/special-settings";

const errorDetailsDialogMock = vi.hoisted(() => ({
  props: [] as Array<{ specialSettings?: SpecialSetting[] | null }>,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

vi.mock("@/app/[locale]/dashboard/_components/ip-details-dialog", () => ({
  IpDetailsDialog: () => null,
}));

vi.mock("@/app/[locale]/dashboard/_components/ip-display-trigger", () => ({
  IpDisplayTrigger: () => null,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/relative-time", () => ({
  RelativeTime: () => <span>-</span>,
}));

vi.mock("@/components/ui/table", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Table: passthrough,
    TableBody: passthrough,
    TableCell: passthrough,
    TableHead: passthrough,
    TableHeader: passthrough,
    TableRow: passthrough,
  };
});

vi.mock("@/components/ui/tooltip", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Tooltip: passthrough,
    TooltipContent: passthrough,
    TooltipProvider: passthrough,
    TooltipTrigger: passthrough,
  };
});

vi.mock("@/app/[locale]/dashboard/logs/_components/error-details-dialog", () => ({
  ErrorDetailsDialog: (props: { specialSettings?: SpecialSetting[] | null }) => {
    errorDetailsDialogMock.props.push(props);
    return null;
  },
}));

vi.mock("@/app/[locale]/dashboard/logs/_components/model-display-with-redirect", () => ({
  ModelDisplayWithRedirect: ({ currentModel }: { currentModel: string | null }) => (
    <span>{currentModel}</span>
  ),
}));

vi.mock("@/app/[locale]/dashboard/logs/_components/provider-chain-popover", () => ({
  ProviderChainPopover: () => null,
}));

const effortSettings: SpecialSetting[] = [
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

const log = {
  id: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  sessionId: null,
  requestSequence: null,
  userName: "user",
  keyName: "key",
  providerName: "anthropic",
  model: "claude-opus-4-6",
  originalModel: "claude-opus-4-6",
  actualResponseModel: null,
  endpoint: "/v1/messages",
  statusCode: 200,
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheTtlApplied: null,
  totalTokens: 30,
  costUsd: "0.01",
  costMultiplier: null,
  groupCostMultiplier: null,
  costBreakdown: null,
  hedgeLosers: null,
  durationMs: 100,
  ttfbMs: 20,
  errorMessage: null,
  providerChain: null,
  blockedBy: null,
  blockedReason: null,
  userAgent: null,
  clientIp: null,
  messagesCount: 1,
  context1mApplied: null,
  swapCacheTtlApplied: null,
  specialSettings: effortSettings,
} satisfies UsageLogRow;

describe("UsageLogsTable effort audit handoff", () => {
  beforeEach(() => {
    errorDetailsDialogMock.props.length = 0;
    document.body.innerHTML = "";
  });

  it("passes rule-compatible before/after special settings to the detail dialog", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <UsageLogsTableForTest
          logs={[log]}
          total={1}
          page={1}
          pageSize={20}
          onPageChange={() => undefined}
          isPending={false}
        />
      );
    });

    expect(errorDetailsDialogMock.props).toHaveLength(1);
    expect(errorDetailsDialogMock.props[0]?.specialSettings).toBe(effortSettings);
    expect(effortSettings[1]?.type).toBe("provider_parameter_override");

    act(() => root.unmount());
    container.remove();
  });
});
