/** @vitest-environment happy-dom */

const mockDispatch = vi.fn();
const mockUseProviderForm = vi.fn();
const testerProps = vi.hoisted(() => ({ redirect: [] as any[], allowed: [] as any[] }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("framer-motion", () => ({
  motion: { div: ({ children, ...rest }: any) => <div {...rest}>{children}</div> },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock(
  "@/app/[locale]/settings/providers/_components/forms/provider-form/provider-form-context",
  () => ({
    useProviderForm: (...args: any[]) => mockUseProviderForm(...args),
  })
);
vi.mock("@/app/[locale]/settings/providers/_components/rule-tester-dialog-trigger", () => ({
  RuleTesterDialogTrigger: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/app/[locale]/settings/providers/_components/model-redirect-tester", () => ({
  ModelRedirectTester: (props: any) => {
    testerProps.redirect.push(props);
    return <div data-testid="redirect-tester" />;
  },
}));
vi.mock("@/app/[locale]/settings/providers/_components/allowed-model-tester", () => ({
  AllowedModelTester: (props: any) => {
    testerProps.allowed.push(props);
    return <div data-testid="allowed-tester" />;
  },
}));
vi.mock("@/app/[locale]/settings/providers/_components/model-redirect-editor", () => ({
  ModelRedirectEditor: () => <div data-testid="redirect-editor" />,
}));
vi.mock("@/app/[locale]/settings/providers/_components/allowed-model-rule-editor", () => ({
  AllowedModelRuleEditor: () => <div data-testid="allowed-editor" />,
}));
vi.mock("@/app/[locale]/settings/providers/_components/batch-edit/mixed-value-indicator", () => ({
  MixedValueIndicator: () => <div />,
}));
vi.mock("@/components/form/client-restrictions-editor", () => ({
  ClientRestrictionsEditor: () => <div />,
}));
vi.mock("@/components/ui/tag-input", () => ({ TagInput: () => <div /> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => <button type="button" /> }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <>{children}</>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children }: any) => <>{children}</>,
}));

import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutingSection } from "@/app/[locale]/settings/providers/_components/forms/provider-form/sections/routing-section";

function render(node: React.ReactNode) {
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

function createState(providerPrefix: string) {
  return {
    basic: { name: "", url: "", key: "", websiteUrl: "" },
    routing: {
      providerType: "openai-compatible",
      groupTag: [],
      preserveClientIp: false,
      disableSessionReuse: false,
      overwriteResponseModel: false,
      providerPrefix,
      modelRedirects: [],
      allowedModels: [],
      allowedClients: [],
      blockedClients: [],
      priority: 0,
      groupPriorities: {},
      weight: 1,
      costMultiplier: 1,
      activeTimeStart: null,
      activeTimeEnd: null,
    },
    network: { proxyUrl: "", proxyFallbackToDirect: false },
    ui: { isPending: false },
  } as any;
}

function renderSection(providerPrefix: string, mode: "create" | "edit" | "batch" = "create") {
  mockUseProviderForm.mockReturnValue({
    state: createState(providerPrefix),
    dispatch: mockDispatch,
    mode,
    provider: undefined,
    enableMultiProviderTypes: true,
    groupSuggestions: [],
    batchAnalysis: null,
  });
  return render(<RoutingSection />);
}

describe("RoutingSection - provider prefix", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    testerProps.redirect.length = 0;
    testerProps.allowed.length = 0;
  });

  it("renders the prefix input and dispatches SET_PROVIDER_PREFIX on change", () => {
    const { container, unmount } = renderSection("");
    const input = container.querySelector("#provider-prefix") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(container.textContent).toContain("sections.routing.providerPrefix.desc");

    act(() => {
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "openai");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_PROVIDER_PREFIX", payload: "openai" });
    unmount();
  });

  it("shows the normalized prefix preview and passes the prefix to the testers", () => {
    const { container, unmount } = renderSection("openai//", "edit");

    expect(container.querySelector("#edit-provider-prefix")).toBeTruthy();
    expect(container.textContent).toContain('"prefix":"openai/"');
    expect(container.textContent).toContain('"example":"openai/gpt-5"');
    expect(testerProps.redirect.at(-1)?.providerPrefix).toBe("openai//");
    expect(testerProps.allowed.at(-1)?.providerPrefix).toBe("openai//");
    unmount();
  });

  it("hides the prefix input in batch mode", () => {
    const { container, unmount } = renderSection("openai", "batch");

    expect(container.querySelector("#provider-prefix")).toBeNull();
    expect(testerProps.redirect.at(-1)?.providerPrefix).toBeNull();
    unmount();
  });
});
