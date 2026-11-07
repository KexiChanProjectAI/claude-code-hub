/**
 * Make display names unique within one model list.
 *
 * Model pickers (Codex's `/model`) show only the display name, so two routes to the same model
 * (`daily/gpt-6-sol` and `gpt-6-sol`, both "GPT-6-Sol") look identical. Within each group that
 * shares a name, an id with a namespace gets it appended ("GPT-6-Sol (daily)") while the
 * un-namespaced id keeps the plain name. Any name still shared after that falls back to the id,
 * which is unique. Names that were already unique are never changed.
 */
export function disambiguateDisplayNames<T>(
  items: readonly T[],
  getId: (item: T) => string,
  getName: (item: T) => string,
  setName: (item: T, name: string) => void
): void {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = getName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  for (const item of items) {
    const name = getName(item);
    if ((counts.get(name) ?? 0) < 2) continue;
    const id = getId(item);
    const slash = id.lastIndexOf("/");
    if (slash > 0) setName(item, `${name} (${id.slice(0, slash)})`);
  }

  const after = new Map<string, number>();
  for (const item of items) {
    const name = getName(item);
    after.set(name, (after.get(name) ?? 0) + 1);
  }
  for (const item of items) {
    if ((after.get(getName(item)) ?? 0) > 1) setName(item, getId(item));
  }
}
