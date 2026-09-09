import type { StructuredMessage } from "./types";

export const TITLE_PREFIX_MAX_LENGTH = 64;

export function normalizeTitlePrefix(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, TITLE_PREFIX_MAX_LENGTH);
}

/**
 * Prefix alert titles so operators can tell instances apart (e.g. [PROXY]).
 */
export function applyNotificationTitlePrefix(
  message: StructuredMessage,
  prefix: string | null | undefined
): StructuredMessage {
  const normalized = normalizeTitlePrefix(prefix);
  if (!normalized) return message;

  const tag = `[${normalized}]`;
  if (message.header.title.startsWith(`${tag} `) || message.header.title === tag) {
    return message;
  }

  return {
    ...message,
    header: {
      ...message.header,
      title: `${tag} ${message.header.title}`,
    },
  };
}
