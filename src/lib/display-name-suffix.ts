/**
 * Provider display-name suffix: a label appended to the display names of the provider's models
 * in model pickers, e.g. suffix "cyber" shows "GPT-6-Sol" as "GPT-6-Sol (cyber)". It only changes
 * presentation; model ids and routing are untouched.
 */

/** Maximum suffix length after normalization (matches the varchar(64) column). */
export const DISPLAY_NAME_SUFFIX_MAX_LENGTH = 64;

/**
 * Trim, drop one pair of wrapping parentheses ("(cyber)" -> "cyber") and collapse inner
 * whitespace. Empty input means "no suffix" and yields null.
 */
export function normalizeDisplayNameSuffix(input: string | null | undefined): string | null {
  if (input == null) return null;
  let value = input.trim();
  if (value.startsWith("(") && value.endsWith(")")) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\s+/g, " ");
  return value ? value : null;
}

/** "GPT-6-Sol" + "cyber" -> "GPT-6-Sol (cyber)"; no suffix leaves the name unchanged. */
export function applyDisplayNameSuffix(name: string, suffix: string | null | undefined): string {
  const normalized = normalizeDisplayNameSuffix(suffix);
  return normalized ? `${name} (${normalized})` : name;
}
