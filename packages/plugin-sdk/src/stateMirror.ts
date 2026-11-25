import type { StateGroup } from "./protocol";

export type GroupPages = { complete: StateGroup[]; waiting: Map<string, StateGroup[]> };

export function joinGroupPages(groups: readonly StateGroup[], waiting: Map<string, StateGroup[]> = new Map()): GroupPages {
  const complete: StateGroup[] = [];
  for (const group of groups) {
    const page = group.tabIdsPage;
    if (!page) {
      waiting.delete(group.id);
      complete.push(group);
      continue;
    }
    const pages = page.index === 0 ? [] : (waiting.get(group.id) ?? []);
    if (pages.length !== page.index) {
      waiting.delete(group.id);
      continue;
    }
    pages.push(group);
    if (pages.length < page.count) {
      waiting.set(group.id, pages);
      continue;
    }
    waiting.delete(group.id);
    const { tabIdsPage: _page, ...rest } = group;
    complete.push({ ...rest, tabIds: pages.flatMap((p) => p.tabIds) });
  }
  return { complete, waiting };
}
