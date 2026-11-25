type Press = { windowId: string; kind: "open" | "close"; tabId: string; until: number };

const PRESS_MS = 1000;
let pending: Press[] = [];

const live = (now: number) => (pending = pending.filter((p) => p.until > now));
const drop = (windowId: string, tabIds: string[]) => void (pending = pending.filter((p) => p.windowId !== windowId || !tabIds.includes(p.tabId)));

export function markStripPress(windowId: string, kind: Press["kind"], tabId: string, now = Date.now()) {
  if (tabId) live(now).push({ windowId, kind, tabId, until: now + PRESS_MS });
}

export function pressStripClose(windowId: string, tabId: string, close: () => void, stillOpen: (tabId: string) => boolean) {
  markStripPress(windowId, "close", tabId);
  close();
  if (stillOpen(tabId)) drop(windowId, [tabId]);
}

export function pressStripOpen(windowId: string, open: () => string | null | undefined, isOpen: (tabId: string) => boolean) {
  const tabId = open();
  if (tabId && isOpen(tabId)) markStripPress(windowId, "open", tabId);
}

export function matchStripPress(windowId: string, closed: string[], opened: string[], now = Date.now()): string[] {
  return live(now).flatMap((p) => (p.windowId === windowId && (p.kind === "close" ? closed : opened).includes(p.tabId) ? [p.tabId] : []));
}

export const ackStripPress = (windowId: string, tabIds: string[]) => void (tabIds.length && drop(windowId, tabIds));
