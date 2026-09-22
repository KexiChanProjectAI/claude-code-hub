import { describe, expect, it } from "vitest";
import { extractModelFromPath, extractPrefixedModelFromPath } from "@/app/v1/_lib/proxy/session";
import { detectFormatByEndpoint } from "@/app/v1/_lib/proxy/format-mapper";

describe("extractModelFromPath - Vertex AI publishers path", () => {
  it("extracts model from /v1/publishers/google/models/{model}:generateContent", () => {
    expect(
      extractModelFromPath(
        "/v1/publishers/google/models/gemini-3-pro-image-preview:generateContent"
      )
    ).toBe("gemini-3-pro-image-preview");
  });

  it("extracts model from /v1/publishers/google/models/{model}:streamGenerateContent", () => {
    expect(
      extractModelFromPath("/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent")
    ).toBe("gemini-2.5-flash");
  });

  it("extracts model from /v1/publishers/google/models/{model}:countTokens", () => {
    expect(extractModelFromPath("/v1/publishers/google/models/gemini-2.5-pro:countTokens")).toBe(
      "gemini-2.5-pro"
    );
  });

  it("extracts model from path without action suffix", () => {
    expect(extractModelFromPath("/v1/publishers/google/models/gemini-2.5-flash")).toBe(
      "gemini-2.5-flash"
    );
  });

  // regression: existing patterns still work
  it("still extracts model from /v1beta/models/{model}:generateContent", () => {
    expect(extractModelFromPath("/v1beta/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini-2.5-flash"
    );
  });

  it("still extracts model from /v1/models/{model}:generateContent", () => {
    expect(extractModelFromPath("/v1/models/gemini-2.5-pro:generateContent")).toBe(
      "gemini-2.5-pro"
    );
  });

  it("returns null for unrecognized paths", () => {
    expect(extractModelFromPath("/v1/messages")).toBeNull();
    expect(extractModelFromPath("/v1/chat/completions")).toBeNull();
  });
});

describe("detectFormatByEndpoint - Vertex AI publishers path", () => {
  it('returns "gemini" for /v1/publishers/google/models/{model}:generateContent', () => {
    expect(
      detectFormatByEndpoint(
        "/v1/publishers/google/models/gemini-3-pro-image-preview:generateContent"
      )
    ).toBe("gemini");
  });

  it('returns "gemini" for /v1/publishers/google/models/{model}:streamGenerateContent', () => {
    expect(
      detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent")
    ).toBe("gemini");
  });

  it('returns "gemini" for /v1/publishers/google/models/{model}:countTokens', () => {
    expect(detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-pro:countTokens")).toBe(
      "gemini"
    );
  });

  // regression: existing patterns still work
  it('still returns "gemini" for /v1beta/models/ path', () => {
    expect(detectFormatByEndpoint("/v1beta/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini"
    );
  });

  it('still returns "gemini-cli" for /v1internal/models/ path', () => {
    expect(detectFormatByEndpoint("/v1internal/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini-cli"
    );
  });

  it("returns null for unknown publishers path actions", () => {
    expect(
      detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-flash:unknownAction")
    ).toBeNull();
  });
});

describe("extractPrefixedModelFromPath - model IDs with a provider prefix", () => {
  it("captures a slash-containing model from /v1beta/models when the prefix is configured", () => {
    expect(
      extractPrefixedModelFromPath("/v1beta/models/google/gemini-2.5-flash:generateContent", [
        "google/",
      ])
    ).toBe("google/gemini-2.5-flash");
  });

  it("matches configured prefixes case-insensitively", () => {
    expect(
      extractPrefixedModelFromPath("/v1beta/models/Google/gemini-2.5-flash:generateContent", [
        "google/",
      ])
    ).toBe("Google/gemini-2.5-flash");
  });

  it("captures a slash-containing model from the Vertex publishers path", () => {
    expect(
      extractPrefixedModelFromPath(
        "/v1/projects/p/locations/us/publishers/google/models/vertex/gemini-2.5-pro:streamGenerateContent",
        ["vertex/"]
      )
    ).toBe("vertex/gemini-2.5-pro");
  });

  it("captures a slash-containing model from /v1/models without an action", () => {
    expect(extractPrefixedModelFromPath("/v1/models/google/gemini-2.5-pro", ["google/"])).toBe(
      "google/gemini-2.5-pro"
    );
  });

  it("returns null when no provider prefix is configured", () => {
    expect(
      extractPrefixedModelFromPath("/v1beta/models/google/gemini-2.5-flash:generateContent", [])
    ).toBeNull();
  });

  it("returns null when the path does not start with a configured prefix", () => {
    expect(
      extractPrefixedModelFromPath("/v1beta/models/veo-3.0/operations/op-1:cancel", ["google/"])
    ).toBeNull();
    expect(
      extractPrefixedModelFromPath("/v1beta/models/veo-3.0/operations/abc123", ["google/"])
    ).toBeNull();
  });

  it("returns null for slash-free model segments", () => {
    expect(
      extractPrefixedModelFromPath("/v1beta/models/gemini-2.5-flash:generateContent", ["google/"])
    ).toBeNull();
  });
});

// Pre-provider-prefix implementation, kept verbatim to pin legacy behavior.
function legacyExtractModelFromPath(pathname: string): string | null {
  const publishersMatch = pathname.match(/\/publishers\/google\/models\/([^/:]+)(?::[^/]+)?/);
  if (publishersMatch?.[1]) return publishersMatch[1];
  const geminiMatch = pathname.match(/\/v1beta\/models\/([^/:]+)(?::[^/]+)?/);
  if (geminiMatch?.[1]) return geminiMatch[1];
  const v1Match = pathname.match(/\/v1\/models\/([^/:]+)(?::[^/]+)?/);
  if (v1Match?.[1]) return v1Match[1];
  return null;
}

describe("extractModelFromPath - unchanged for paths without a slash-containing model", () => {
  const paths = [
    "/v1beta/models/gemini-2.5-flash:generateContent",
    "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    "/v1beta/models/gemini-2.5-flash",
    "/v1beta/models/gemini-2.5-flash/",
    "/v1beta/models/",
    "/v1beta/models",
    "/v1beta/models/veo-3.0-generate-preview:predictLongRunning",
    "/v1beta/models/veo-3.0-generate-preview/operations/abc123",
    "/v1beta/models/gemini-2.5-flash/operations/op-1:cancel",
    "/v1beta/tunedModels/my-model:generateContent",
    "/v1/models/gemini-2.5-pro:generateContent",
    "/v1/models/gemini-2.5-pro",
    "/v1/models",
    "/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent",
    "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
    "/v1/projects/p/locations/us/publishers/google/models/imagen-3.0/operations/x",
    "/v1internal:generateContent",
    "/v1/messages",
    "/v1/chat/completions",
  ];

  it.each(paths)("matches the legacy result for %s", (path) => {
    expect(extractModelFromPath(path)).toBe(legacyExtractModelFromPath(path));
  });

  it("keeps extracting the model from a long-running operations path", () => {
    expect(extractModelFromPath("/v1beta/models/veo-3.0-generate-preview/operations/abc123")).toBe(
      "veo-3.0-generate-preview"
    );
  });
});
