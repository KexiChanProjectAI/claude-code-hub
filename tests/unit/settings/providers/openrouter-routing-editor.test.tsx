/** @vitest-environment happy-dom */

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: any) => (
    <div data-select-value={value}>
      {children}
      <select
        data-testid="native-select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value={value}>{value}</option>
        {["inherit", "price", "throughput", "latency", "allow", "deny", "true", "false"].map(
          (v) => (
            <option key={v} value={v}>
              {v}
            </option>
          )
        )}
      </select>
    </div>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
  SelectTrigger: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  SelectValue: () => null,
}));

import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenRouterUpstreamBadge } from "@/app/[locale]/dashboard/logs/_components/openrouter-upstream-badge";
import {
  OpenRouterRoutingEditor,
  parseNonNegativeNumberText,
  parseSlugListText,
  patchOpenRouterRouting,
} from "@/app/[locale]/settings/providers/_components/openrouter-routing-editor";
import type { OpenRouterProviderRouting } from "@/types/provider";

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    if (input instanceof HTMLInputElement) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

function selectFor(container: HTMLElement, testId: string) {
  const trigger = container.querySelector(`[data-testid='${testId}']`);
  return trigger?.parentElement?.querySelector("select") as HTMLSelectElement;
}

describe("openrouter-routing-editor helpers", () => {
  it("parses comma and newline separated slug lists", () => {
    expect(parseSlugListText(" deepinfra, together\nfireworks ,, ")).toEqual([
      "deepinfra",
      "together",
      "fireworks",
    ]);
    expect(parseSlugListText("  ,  ")).toBeUndefined();
  });

  it("parses non-negative numbers", () => {
    expect(parseNonNegativeNumberText("1.5")).toBe(1.5);
    expect(parseNonNegativeNumberText("0")).toBe(0);
    expect(parseNonNegativeNumberText("")).toBeUndefined();
    expect(parseNonNegativeNumberText("-1")).toBeUndefined();
    expect(parseNonNegativeNumberText("abc")).toBeUndefined();
  });

  it("patches and drops undefined keys", () => {
    expect(patchOpenRouterRouting({ sort: "price", zdr: true }, { sort: undefined })).toEqual({
      zdr: true,
    });
  });
});

describe("OpenRouterRoutingEditor", () => {
  function setup(initial: OpenRouterProviderRouting = {}) {
    let value = initial;
    const onChange = vi.fn((next: OpenRouterProviderRouting) => {
      value = next;
      view.rerender(<OpenRouterRoutingEditor value={value} onChange={onChange} />);
    });
    const view = render(<OpenRouterRoutingEditor value={value} onChange={onChange} />);
    return { ...view, onChange, getValue: () => value };
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows an empty preview when nothing is configured", () => {
    const { container, unmount } = setup();
    expect(container.querySelector("[data-testid='openrouter-routing-preview']")?.textContent).toBe(
      "preview.empty"
    );
    unmount();
  });

  it("toggles quantizations in canonical order", () => {
    const { container, getValue, unmount } = setup();
    const click = (q: string) =>
      act(() =>
        (
          container.querySelector(`[data-testid='openrouter-quantization-${q}']`) as HTMLElement
        ).click()
      );
    click("bf16");
    click("fp16");
    expect(getValue().quantizations).toEqual(["fp16", "bf16"]);
    expect(
      container
        .querySelector("[data-testid='openrouter-quantization-fp16']")
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    click("fp16");
    click("bf16");
    expect(getValue().quantizations).toBeUndefined();
    unmount();
  });

  it("updates sort, data collection and boolean flags", () => {
    const { container, getValue, unmount } = setup({ sort: "latency" });

    setInputValue(selectFor(container, "openrouter-sort"), "price");
    expect(getValue().sort).toBe("price");
    setInputValue(selectFor(container, "openrouter-sort"), "inherit");
    expect(getValue().sort).toBeUndefined();

    setInputValue(selectFor(container, "openrouter-data-collection"), "deny");
    expect(getValue().data_collection).toBe("deny");

    setInputValue(selectFor(container, "openrouter-flag-zdr"), "true");
    setInputValue(selectFor(container, "openrouter-flag-allow_fallbacks"), "false");
    expect(getValue()).toMatchObject({ zdr: true, allow_fallbacks: false });
    setInputValue(selectFor(container, "openrouter-flag-zdr"), "inherit");
    expect(getValue().zdr).toBeUndefined();
    unmount();
  });

  it("parses provider lists, prices and performance numbers", () => {
    const { container, getValue, unmount } = setup({ max_price: { image: 1 } });
    const input = (id: string) =>
      container.querySelector(`[data-testid='${id}']`) as HTMLInputElement;

    setInputValue(input("openrouter-list-order"), "deepinfra, together");
    setInputValue(input("openrouter-list-ignore"), "novita");
    setInputValue(input("openrouter-max-price-prompt"), "0.5");
    setInputValue(input("openrouter-number-preferred_max_latency"), "3");
    expect(getValue()).toEqual({
      order: ["deepinfra", "together"],
      ignore: ["novita"],
      max_price: { image: 1, prompt: 0.5 },
      preferred_max_latency: 3,
    });
    expect(input("openrouter-list-order").value).toBe("deepinfra, together");

    setInputValue(input("openrouter-max-price-prompt"), "");
    setInputValue(input("openrouter-max-price-image"), "");
    setInputValue(input("openrouter-list-order"), "");
    expect(getValue()).toEqual({ ignore: ["novita"], preferred_max_latency: 3 });

    const preview = container.querySelector(
      "[data-testid='openrouter-routing-preview']"
    )?.textContent;
    expect(JSON.parse(preview ?? "{}")).toEqual({
      provider: { ignore: ["novita"], preferred_max_latency: 3 },
    });
    unmount();
  });
});

describe("OpenRouterUpstreamBadge", () => {
  it("renders the upstream provider from special settings", () => {
    const { container, unmount } = render(
      <OpenRouterUpstreamBadge
        specialSettings={[
          {
            type: "openrouter_upstream_provider",
            scope: "response",
            hit: true,
            upstreamProvider: "DeepInfra",
            generationId: "gen-1",
          },
        ]}
      />
    );
    const badge = container.querySelector("[data-testid='openrouter-upstream-badge']");
    expect(badge?.textContent).toBe("DeepInfra");
    expect(badge?.getAttribute("title")).toBe('badgeTitle:{"provider":"DeepInfra"}');
    unmount();
  });

  it("renders nothing without the setting", () => {
    const { container, unmount } = render(<OpenRouterUpstreamBadge specialSettings={null} />);
    expect(container.innerHTML).toBe("");
    unmount();
  });
});
