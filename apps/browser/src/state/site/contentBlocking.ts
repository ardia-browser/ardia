import { setContentBlockerEnabled, setFilterListEnabled, type ContentBlockerState, type FilterListCategory } from "../../platform/contentBlocker";

export const blockerAvailable = (s: ContentBlockerState | null): s is ContentBlockerState => !!s && s.stats.ready !== false && s.lists.length > 0;

export const categoryOn = (s: ContentBlockerState, category: FilterListCategory) => s.enabled && s.lists.some((l) => l.category === category && l.enabled);

async function setLists(s: ContentBlockerState, ids: string[], on: boolean) {
  for (const id of ids) await setFilterListEnabled(id, on);
  const anyOn = s.lists.some((l) => (ids.includes(l.id) ? on : s.enabled && l.enabled));
  if (anyOn !== s.enabled) await setContentBlockerEnabled(anyOn);
}

export function setBlockingCategory(s: ContentBlockerState, category: FilterListCategory, on: boolean) {
  const lists = s.lists.filter((l) => l.category === category);
  const usual = lists.filter((l) => l.defaultOn || l.enabled);
  const starters = usual.length ? usual : lists.filter((l) => /easylist|fanboy/.test(l.id));
  const changed = on ? (starters.length ? starters : lists) : lists.filter((l) => l.enabled);
  return setLists(s, changed.map((l) => l.id), on);
}

export const setFilterList = (s: ContentBlockerState, id: string, on: boolean) => setLists(s, [id], on);

const LIST_ADDRESS_LIMIT = 2048;

export function filterListAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text || text.length > LIST_ADDRESS_LIMIT || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function filterListLabel(id: string, title: string): string {
  if (title && title !== id) return title;
  try {
    const url = new URL(id);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return id;
  }
}
