/**
 * Models that only work on the OpenAI image endpoints (`/v1/images/generations`,
 * `/v1/images/edits`, `/v1/images/variations`). Upstreams reject them on `/v1/responses`,
 * `/v1/chat/completions` and `/v1/messages`, so chat-protocol listings (the Codex catalog,
 * protocol-hinted `/models`, `/v1/responses/models`, `/v1/chat/models`) must not offer them.
 * The generic `/v1/models` keeps them for image clients.
 *
 * Matched on the bare model name (after any provider prefix / namespace), case-insensitive.
 */
const IMAGE_ONLY_MODEL = /^(?:gpt-image|chatgpt-image|dall-e)(?:-|$)/;

export function isImageOnlyModel(modelId: string): boolean {
  const bare = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  return IMAGE_ONLY_MODEL.test(bare);
}

/** Keep models usable on chat-style endpoints. */
export function filterChatCapableModels<T extends { id: string }>(models: readonly T[]): T[] {
  return models.filter((model) => !isImageOnlyModel(model.id));
}
