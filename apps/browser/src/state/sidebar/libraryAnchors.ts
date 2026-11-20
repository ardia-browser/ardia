import type { Anchor } from "./sidebarUi";

type Measurable = { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => void };

const anchors = new Map<string, Map<string, Set<Measurable>>>();
const pointed = new Map<string, Measurable>();

export const pointLibraryAnchor = (windowId: string, view: Measurable) => void pointed.set(windowId, view);

export function addLibraryAnchor(windowId: string, id: string, view: Measurable) {
  let byId = anchors.get(windowId);
  if (!byId) anchors.set(windowId, (byId = new Map()));
  let views = byId.get(id);
  if (!views) byId.set(id, (views = new Set()));
  views.add(view);
  return () => {
    if (pointed.get(windowId) === view) pointed.delete(windowId);
    if (!views.delete(view) || views.size) return;
    if (byId.get(id) === views) byId.delete(id);
    if (!byId.size && anchors.get(windowId) === byId) anchors.delete(windowId);
  };
}

const measured = (view: Measurable) =>
  new Promise<Anchor | null>((resolve) => view.measureInWindow((x, y, width, height) => resolve(width > 0 && height > 0 ? { x, y, width, height } : null)));

export function measureLibraryAnchor(windowId: string, id: string): Promise<Anchor | null> {
  const views = anchors.get(windowId)?.get(id);
  if (!views?.size) return Promise.resolve(null);
  const first = pointed.get(windowId);
  const ordered = first && views.has(first) ? [first, ...[...views].filter((view) => view !== first)] : [...views];
  return Promise.all(ordered.map(measured)).then((found) => found.find((anchor) => !!anchor) ?? null);
}
