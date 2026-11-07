import { describe, expect, it } from "vitest";
import { filterChatCapableModels, isImageOnlyModel } from "@/lib/model-endpoint-capability";

describe("isImageOnlyModel", () => {
  it.each([
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
    "daily/gpt-image-2",
    "openai/GPT-Image-1-mini",
    "chatgpt-image-latest",
    "dall-e-2",
    "dall-e-3",
    "gpt-image",
  ])("matches image-only model %s", (id) => {
    expect(isImageOnlyModel(id)).toBe(true);
  });

  it.each(["gpt-6-sol", "daily/gpt-6.1-sol", "gpt-imagery", "gpt-4o", "my-gpt-image-1", ""])(
    "keeps chat model %s",
    (id) => {
      expect(isImageOnlyModel(id)).toBe(false);
    }
  );
});

describe("filterChatCapableModels", () => {
  it("drops image-only models and keeps order", () => {
    expect(
      filterChatCapableModels([{ id: "b" }, { id: "daily/gpt-image-2" }, { id: "a" }])
    ).toEqual([{ id: "b" }, { id: "a" }]);
  });
});
