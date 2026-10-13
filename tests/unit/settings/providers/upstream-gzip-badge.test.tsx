/**
 * @vitest-environment happy-dom
 */

import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { UpstreamGzipBadge } from "@/app/[locale]/settings/providers/_components/upstream-gzip-badge";
import type { ProviderUpstreamGzipStatusMap } from "@/types/upstream-gzip";

const apiMocks = vi.hoisted(() => ({
  getProvidersUpstreamGzipStatus: vi.fn(async (): Promise<ProviderUpstreamGzipStatusMap> => ({})),
}));
vi.mock("@/lib/api-client/v1/actions/providers", () => apiMocks);

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

const listMessages = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "messages/en/settings/providers/list.json"), "utf8")
);

async function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={{ settings: { providers: { list: listMessages } } }}
      >
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("UpstreamGzipBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("展示上下行状态与更新时间", async () => {
    apiMocks.getProvidersUpstreamGzipStatus.mockResolvedValue({
      5: {
        request: { state: "unsupported", updatedAt: Date.now() - 60_000 },
        response: { state: "compressed", updatedAt: null },
      },
    });

    const { container, unmount } = await render(<UpstreamGzipBadge providerId={5} enabled />);

    const text = container.textContent ?? "";
    expect(text).toContain("gzip");
    expect(text).toContain("Rejects gzip, sending plain");
    expect(text).toContain("Returns gzip");
    expect(text).toContain("Updated");
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain(
      "Upload (request body) Rejects gzip, sending plain"
    );
    unmount();
  });

  test("两个方向都关闭或无数据时不渲染", async () => {
    apiMocks.getProvidersUpstreamGzipStatus.mockResolvedValue({
      5: {
        request: { state: "disabled", updatedAt: null },
        response: { state: "disabled", updatedAt: null },
      },
    });

    const disabled = await render(<UpstreamGzipBadge providerId={5} enabled />);
    expect(disabled.container.textContent).toBe("");
    disabled.unmount();

    const missing = await render(<UpstreamGzipBadge providerId={6} enabled />);
    expect(missing.container.textContent).toBe("");
    missing.unmount();
  });

  test("未启用时不请求数据", async () => {
    const { container, unmount } = await render(
      <UpstreamGzipBadge providerId={5} enabled={false} />
    );
    expect(apiMocks.getProvidersUpstreamGzipStatus).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    unmount();
  });
});
