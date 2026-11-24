import { pageScrollPosition, savePageState } from "../pages/store";
import { currentTabs, reserveStateSave, saveTabState } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { SCROLL_MOVE_THRESHOLD, scrollSaveDecision, type ScrollWatch } from "../../lib/scrollSettle";

const SCROLL_CHECK_MS = 2000;

const watches = new Map<string, ScrollWatch>();
const rests = new Map<string, ScrollWatch>();
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

export async function saveTabPosition(id: string) {
  const save = reserveStateSave(id);
  const at = await pageScrollPosition(id);
  const saved = await savePageState(id);
  if (!saved || !findTab(currentTabs(), id)) return;
  if (saveTabState(id, saved, save) && at) watches.set(id, { lastSeen: at.y, lastSaved: at.y });
}

async function checkFront(frontId: () => string | null, cameToRest: (id: string) => void) {
  const id = frontId();
  if (!id || checking) return;
  checking = true;
  try {
    const at = await pageScrollPosition(id);
    if (!at || frontId() !== id) return;
    const step = scrollSaveDecision(watches.get(id) ?? { lastSeen: null, lastSaved: null }, at.y);
    watches.set(id, step.next);
    const rest = scrollSaveDecision(rests.get(id) ?? { lastSeen: null, lastSaved: null }, at.y);
    rests.set(id, rest.next);
    if (rest.save) cameToRest(id);
    if (step.save) await saveTabPosition(id);
  } finally {
    checking = false;
  }
}

export function watchFrontScroll(frontId: () => string | null, cameToRest: (id: string) => void = () => undefined) {
  if (timer) return;
  timer = setInterval(() => void checkFront(frontId, cameToRest), SCROLL_CHECK_MS);
}

export function frontScrollCameToRest(id: string, y: number, frontId: string | null, cameToRest: (id: string) => void) {
  if (frontId !== id) return;
  const saved = watches.get(id)?.lastSaved ?? null;
  cameToRest(id);
  if (saved === null || Math.abs(y - saved) > SCROLL_MOVE_THRESHOLD) void saveTabPosition(id);
}

export function forgetPosition(id: string) {
  watches.delete(id);
  rests.delete(id);
}
