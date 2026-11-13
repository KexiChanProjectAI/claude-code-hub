/**
 * @vitest-environment happy-dom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, test, vi } from "vitest";
import "../../../framer-motion.mock";
import { ProviderForm } from "../../../../src/app/[locale]/settings/providers/_components/forms/provider-form";
import { Dialog } from "../../../../src/components/ui/dialog";
import enMessages from "../../../../messages/en";

let queryClient: QueryClient;

const sonnerMocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("sonner", () => sonnerMocks);

// The settings test suite globally shims "@/lib/api-client/v1/actions/providers" to re-export
// "@/actions/providers" (see tests/setup.ts), so mocking the legacy actions module here is the
// established way to intercept addProvider/editProvider from a fully-rendered ProviderForm.
const providersActionMocks = vi.hoisted(() => ({
  addProvider: vi.fn(async (_data: unknown) => ({
    ok: true,
    data: { operationId: "op-add", undoToken: "undo-add" },
  })),
  editProvider: vi.fn(async (_providerId: number, _data: unknown) => ({
    ok: true,
    data: { operationId: "op-edit", undoToken: "undo-edit" },
  })),
  removeProvider: vi.fn(async (_providerId: number) => ({ ok: true })),
  getUnmaskedProviderKey: vi.fn(async () => ({ ok: true, data: { key: "test-key" } })),
  getProviderTestPresets: vi.fn(async () => ({ ok: true, data: [] })),
  getModelSuggestionsByProviderGroup: vi.fn(async () => ({ ok: true, data: [] })),
  fetchUpstreamModels: vi.fn(async () => ({ ok: true, data: { models: [] } })),
}));
vi.mock("@/actions/providers", () => providersActionMocks);

const requestFiltersActionMocks = vi.hoisted(() => ({
  getDistinctProviderGroupsAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("@/actions/request-filters", () => requestFiltersActionMocks);

const modelPricesActionMocks = vi.hoisted(() => ({
  getAvailableModelCatalog: vi.fn(async () => []),
  getAvailableModelsByProviderType: vi.fn(async () => []),
}));
vi.mock("@/actions/model-prices", () => modelPricesActionMocks);

const providerEndpointsActionMocks = vi.hoisted(() => ({
  getProviderVendors: vi.fn(async () => []),
  getProviderEndpoints: vi.fn(async () => []),
  addProviderEndpoint: vi.fn(async () => ({ ok: true, data: { endpoint: {} } })),
}));
vi.mock("@/actions/provider-endpoints", () => providerEndpointsActionMocks);

function loadMessages() {
  return {
    common: enMessages.common,
    errors: enMessages.errors,
    ui: enMessages.ui,
    forms: enMessages.forms,
    settings: enMessages.settings,
  };
}

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });

  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setNativeValue(element: HTMLInputElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as unknown as { value?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
    return;
  }
  element.value = value;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ProviderForm protocols card", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  test("hides the protocols card for a gemini provider", async () => {
    const messages = loadMessages();

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Dialog open onOpenChange={() => {}}>
          <ProviderForm
            mode="create"
            enableMultiProviderTypes
            preset={{ providerType: "gemini" }}
          />
        </Dialog>
      </NextIntlClientProvider>
    );

    await flush();

    expect(container.textContent).not.toContain(enMessages.settings.providers.form.protocols.title);
    expect(container.querySelector("#protocol-claude")).toBeNull();

    unmount();
  });

  test("shows the primary protocol checkbox checked and disabled for the default claude provider", async () => {
    const messages = loadMessages();

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Dialog open onOpenChange={() => {}}>
          <ProviderForm mode="create" enableMultiProviderTypes />
        </Dialog>
      </NextIntlClientProvider>
    );

    await flush();

    expect(container.textContent).toContain(enMessages.settings.providers.form.protocols.title);

    const primaryCheckbox = container.querySelector("#protocol-claude") as HTMLButtonElement | null;
    expect(primaryCheckbox).toBeTruthy();
    expect(primaryCheckbox?.hasAttribute("disabled")).toBe(true);
    expect(primaryCheckbox?.getAttribute("data-state")).toBe("checked");

    const openaiCheckbox = container.querySelector("#protocol-openai") as HTMLButtonElement | null;
    expect(openaiCheckbox).toBeTruthy();
    expect(openaiCheckbox?.hasAttribute("disabled")).toBe(false);
    expect(openaiCheckbox?.getAttribute("data-state")).toBe("unchecked");

    unmount();
  });

  test("toggling a non-primary protocol reveals its URL override input", async () => {
    const messages = loadMessages();

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Dialog open onOpenChange={() => {}}>
          <ProviderForm mode="create" enableMultiProviderTypes />
        </Dialog>
      </NextIntlClientProvider>
    );

    await flush();

    expect(container.querySelector("#protocol-openai-url")).toBeNull();

    const openaiCheckbox = container.querySelector("#protocol-openai") as HTMLButtonElement | null;
    expect(openaiCheckbox).toBeTruthy();

    await act(async () => {
      openaiCheckbox?.click();
    });

    expect(openaiCheckbox?.getAttribute("data-state")).toBe("checked");
    expect(container.querySelector("#protocol-openai-url")).toBeTruthy();

    // Unchecking hides the override input again.
    await act(async () => {
      openaiCheckbox?.click();
    });

    expect(container.querySelector("#protocol-openai-url")).toBeNull();

    unmount();
  });

  test("submits the selected protocols and the per-protocol URL override", async () => {
    const messages = loadMessages();

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Dialog open onOpenChange={() => {}}>
          <ProviderForm mode="create" enableMultiProviderTypes />
        </Dialog>
      </NextIntlClientProvider>
    );

    await flush();

    const nameInput = container.querySelector("#name") as HTMLInputElement | null;
    const urlInput = container.querySelector("#url") as HTMLInputElement | null;
    const keyInput = container.querySelector("#key") as HTMLInputElement | null;
    expect(nameInput).toBeTruthy();
    expect(urlInput).toBeTruthy();
    expect(keyInput).toBeTruthy();

    await act(async () => {
      if (!nameInput || !urlInput || !keyInput) return;
      setNativeValue(nameInput, "multi-protocol-provider");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));

      setNativeValue(urlInput, "https://example.com");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));

      setNativeValue(keyInput, "test-key");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const openaiCheckbox = container.querySelector("#protocol-openai") as HTMLButtonElement | null;
    await act(async () => {
      openaiCheckbox?.click();
    });

    const openaiUrlInput = container.querySelector(
      "#protocol-openai-url"
    ) as HTMLInputElement | null;
    expect(openaiUrlInput).toBeTruthy();

    await act(async () => {
      if (!openaiUrlInput) return;
      setNativeValue(openaiUrlInput, "https://openai-override.example.com");
      openaiUrlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container.querySelector("form") as HTMLFormElement | null;
    expect(form).toBeTruthy();

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    for (let i = 0; i < 5; i++) {
      if (providersActionMocks.addProvider.mock.calls.length > 0) break;
      await flush();
    }

    expect(providersActionMocks.addProvider).toHaveBeenCalledTimes(1);
    const payload = providersActionMocks.addProvider.mock.calls[0]?.[0] as {
      protocols?: unknown;
      protocol_urls?: unknown;
    };
    expect(payload.protocols).toEqual(["claude", "openai"]);
    expect(payload.protocol_urls).toEqual({ openai: "https://openai-override.example.com" });

    unmount();
  });
});
