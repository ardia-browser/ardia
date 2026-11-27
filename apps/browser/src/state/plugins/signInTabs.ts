const hidden = new Set<string>();
let openingBesides: ReadonlySet<string> | null = null;

export const hideSignInTab = (tabId: string) => void hidden.add(tabId);

export const showSignInTab = (tabId: string) => void hidden.delete(tabId);

export const isSignInTab = (tabId: string) => hidden.has(tabId) || (openingBesides !== null && !openingBesides.has(tabId));

export function openingSignInTab<T>(existing: Iterable<string>, open: () => T): T {
  openingBesides = new Set(existing);
  try {
    return open();
  } finally {
    openingBesides = null;
  }
}

const HIDDEN_TAB_TEXT = "a tab plugins can't see";

const isHiddenItem = (item: unknown, ids: ReadonlySet<string>) =>
  (typeof item === "string" && ids.has(item)) || (!!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && ids.has((item as { id: string }).id));

function scrubbed(value: unknown, ids: ReadonlySet<string>, pattern: RegExp): unknown {
  if (typeof value === "string") return ids.has(value) ? null : value.replace(pattern, HIDDEN_TAB_TEXT);
  if (Array.isArray(value)) return value.filter((item) => !isHiddenItem(item, ids)).map((item) => scrubbed(item, ids, pattern));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubbed(item, ids, pattern);
    return out;
  }
  return value;
}

export function withoutSignInTabs<T>(value: T): T {
  if (!hidden.size) return value;
  const escaped = [...hidden].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return scrubbed(value, hidden, new RegExp(escaped.join("|"), "g")) as T;
}
