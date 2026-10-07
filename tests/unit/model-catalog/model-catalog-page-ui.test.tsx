/**
 * @vitest-environment happy-dom
 */

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, test, vi } from "vitest";
import enMessages from "../../../messages/en";
import ruMessages from "../../../messages/ru";
import zhCNMessages from "../../../messages/zh-CN";
import { AgentNotes } from "@/app/[locale]/models/_components/agent-notes";
import { ModelCatalogView } from "@/app/[locale]/models/_components/model-catalog-view";
import type { ModelCatalog } from "@/lib/model-catalog/types";

// Render every tab panel so both views can be asserted at once.
vi.mock("@/components/ui/tabs", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Tabs: Pass, TabsList: Pass, TabsTrigger: Pass, TabsContent: Pass };
});

const catalog: ModelCatalog = {
  generatedAt: "2026-10-07T00:00:00.000Z",
  models: [
    {
      id: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      vendor: "anthropic",
      vendorName: "Anthropic",
      vendorIcon: null,
      vendorIconMono: false,
      protocols: ["claude", "response"],
      contextWindow: 200000,
      maxOutputTokens: 64000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: {
        vision: true,
        functionCalling: true,
        reasoning: false,
        pdfInput: false,
        promptCaching: true,
      },
      modalities: { input: ["text", "image"], output: ["text"] },
      knowledgeCutoff: "2025-03",
      deprecated: true,
      hasPriceData: true,
    },
    {
      id: "mystery-model",
      displayName: "mystery-model",
      vendor: null,
      vendorName: null,
      vendorIcon: null,
      vendorIconMono: false,
      protocols: ["openai"],
      contextWindow: null,
      maxOutputTokens: null,
      pricing: null,
      capabilities: null,
      modalities: null,
      knowledgeCutoff: null,
      deprecated: false,
      hasPriceData: false,
    },
  ],
  protocols: [
    {
      id: "claude",
      label: "Anthropic Messages API",
      endpointPath: "/v1/messages",
      models: ["claude-sonnet-4-5"],
    },
    {
      id: "response",
      label: "OpenAI Responses API",
      endpointPath: "/v1/responses",
      models: ["claude-sonnet-4-5"],
    },
    {
      id: "openai",
      label: "OpenAI Chat Completions API",
      endpointPath: "/v1/chat/completions",
      models: ["mystery-model"],
    },
    { id: "gemini", label: "Gemini API", endpointPath: "/v1beta/x", models: [] },
  ],
  notes: null,
};

function render(locale: string, messages: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <ModelCatalogView catalog={catalog} origin="https://hub.example.com" />
      </NextIntlClientProvider>
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("ModelCatalogView", () => {
  test("renders both views with metadata, prices and copyable endpoints", () => {
    const { container, unmount } = render("en", enMessages);
    const text = container.textContent ?? "";

    expect(text).toContain("https://hub.example.com/v1/models/catalog");
    expect(text).toContain("https://hub.example.com/v1/models/catalog?format=md");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("Claude Sonnet 4.5 / Anthropic");
    expect(text).toContain("Deprecated");
    expect(text).toContain("200K");
    expect(text).toContain("$3.75");
    expect(text).toContain("Prompt caching");
    expect(text).toContain("No metadata");
    expect(text).toContain("1 model");
    expect(text).toContain("0 models");
    expect(text).toContain("No models available through this protocol.");
    expect(text).toContain("/v1/chat/completions");
    unmount();
  });

  test("filters models by search text across both views", () => {
    const { container, unmount } = render("en", enMessages);
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "mystery");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("mystery-model");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "zzz-nothing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No models match.");
    unmount();
  });

  test("renders in other locales with plural rules", () => {
    const ru = render("ru", ruMessages);
    expect(ru.container.textContent).toContain("1 модель");
    ru.unmount();
    const zh = render("zh-CN", zhCNMessages);
    expect(zh.container.textContent).toContain("1 个模型");
    expect(zh.container.textContent).toContain("已弃用");
    zh.unmount();
  });
});

describe("AgentNotes", () => {
  test("renders nothing without notes", () => {
    expect(renderToStaticMarkup(<AgentNotes markdown={null} title="Notes" />)).toBe("");
  });

  test("renders markdown and strips unsafe HTML", () => {
    const html = renderToStaticMarkup(
      <AgentNotes
        markdown={
          "## Rules\n\n- Prefer **Sonnet**\n\n[docs](https://example.com)\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))"
        }
        title="Notes from the administrator"
      />
    );
    expect(html).toContain("Notes from the administrator");
    expect(html).toContain("<h3");
    expect(html).toContain("<strong>Sonnet</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});
