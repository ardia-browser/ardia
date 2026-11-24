import { create } from "zustand";
import {
  closePage,
  isRefusedSnapshot,
  pages,
  type FindResult,
  type PageEngineEvent,
  type PageNavigationState,
  type PageRequest,
  type PageScrollPosition,
  type PageSnapshot,
  type PageState,
  type PageTone,
  type PageViewHandle,
  type RefusedSnapshot,
} from "../../platform/pages";

export type { FindResult, PageEngineEvent, PageNavigationState, PageRequest, PageScrollPosition, PageSnapshot, PageState, PageTone, PageViewHandle, RefusedSnapshot };
export { isRefusedSnapshot };

type PagesState = {
  navigation: Record<string, PageState>;
  tones: Record<string, PageTone>;
  lastTones: Record<string, PageTone>;
  heldTones: Record<string, PageTone>;
  finds: Record<string, FindResult | null>;
  requests: Record<string, PageRequest | null>;
  fullscreen: Record<string, boolean>;
};

export const usePages = create<PagesState>()(() => ({ navigation: {}, tones: {}, lastTones: {}, heldTones: {}, finds: {}, requests: {}, fullscreen: {} }));

const handles = new Map<string, PageViewHandle>();

export function registerPageHandle(id: string, handle: PageViewHandle | null) {
  if (handle) handles.set(id, handle);
  else handles.delete(id);
}

export const pageHandle = (id: string | null) => (id ? handles.get(id) ?? null : null);

export const pageNavigation = (id: string | null) => (id ? usePages.getState().navigation[id] ?? null : null);

export const pageTone = (id: string) => usePages.getState().tones[id] ?? null;

export const storeNavigation = (id: string, navigation: PageState) =>
  usePages.setState((s) => ({ navigation: { ...s.navigation, [id]: navigation } }));

export function storeTone(id: string, tone: PageTone) {
  usePages.setState((s) => ({ tones: { ...s.tones, [id]: tone }, lastTones: { ...s.lastTones, [id]: tone } }));
  reportedSinceHold.add(id);
  if (releasing.has(id)) dropHeldTone(id);
}

export const shownPageTone = (state: Pick<PagesState, "tones" | "lastTones" | "heldTones">, id: string): PageTone | null => state.heldTones[id] ?? state.tones[id] ?? state.lastTones[id] ?? null;

export function holdTone(id: string) {
  releasing.delete(id);
  reportedSinceHold.delete(id);
  const tone = shownPageTone(usePages.getState(), id);
  if (tone) usePages.setState((s) => ({ heldTones: { ...s.heldTones, [id]: tone } }));
}

const releasing = new Set<string>();
const reportedSinceHold = new Set<string>();

function dropHeldTone(id: string) {
  releasing.delete(id);
  if (!usePages.getState().heldTones[id]) return;
  usePages.setState((s) => {
    const heldTones = { ...s.heldTones };
    delete heldTones[id];
    return { heldTones };
  });
}

export function releaseTone(id: string) {
  if (!usePages.getState().heldTones[id]) return;
  if (reportedSinceHold.has(id)) dropHeldTone(id);
  else releasing.add(id);
}

export function clearTone(id: string) {
  if (!usePages.getState().tones[id]) return;
  usePages.setState((s) => {
    const tones = { ...s.tones };
    delete tones[id];
    return { tones };
  });
}

export const storeFind = (id: string, result: FindResult | null) => usePages.setState((s) => ({ finds: { ...s.finds, [id]: result } }));

export const storeRequest = (id: string, request: PageRequest | null) => usePages.setState((s) => ({ requests: { ...s.requests, [id]: request } }));

export const storeFullscreen = (id: string, on: boolean) => usePages.setState((s) => ({ fullscreen: { ...s.fullscreen, [id]: on } }));

export const pageRequest = (id: string | null) => (id ? usePages.getState().requests[id] ?? null : null);

export const pageIsFullscreen = (id: string | null) => (id ? usePages.getState().fullscreen[id] ?? false : false);

export function endPages(ids: readonly string[]) {
  if (!ids.length) return;
  usePages.setState((s) => {
    const navigation = { ...s.navigation };
    const tones = { ...s.tones };
    const lastTones = { ...s.lastTones };
    const heldTones = { ...s.heldTones };
    const finds = { ...s.finds };
    const requests = { ...s.requests };
    const fullscreen = { ...s.fullscreen };
    for (const id of ids) {
      releasing.delete(id);
      reportedSinceHold.delete(id);
      delete navigation[id];
      delete tones[id];
      delete lastTones[id];
      delete heldTones[id];
      delete finds[id];
      delete requests[id];
      delete fullscreen[id];
    }
    return { navigation, tones, lastTones, heldTones, finds, requests, fullscreen };
  });
  for (const id of ids) {
    handles.delete(id);
    void closePage(id);
  }
}

export const settled = <T>(call: () => Promise<T>, fallback: T): Promise<T> =>
  Promise.resolve()
    .then(call)
    .catch(() => fallback);

const settledSync = <T>(call: () => T, fallback: T): T => {
  try {
    return call();
  } catch {
    return fallback;
  }
};

export function snapshotsCommitted(entries: Record<string, string>) {
  if (!Object.keys(entries).length) return;
  try {
    pages.snapshotsCommitted(entries);
  } catch {
    return;
  }
}

export function deletePageSnapshots(ids: readonly string[]) {
  if (!ids.length) return;
  if (settledSync(() => pages.deletesSnapshotsTogether(), false)) {
    void settled(() => pages.deleteSnapshotsFor([...ids]), undefined);
    return;
  }
  for (const id of ids) void settled(() => pages.deleteSnapshots(id), undefined);
}

export const endPrivateSession = () => void settled(() => pages.endPrivateSession(), undefined);

export type SnapshotTiming = "now" | "quiet";

export const snapshotPage = (id: string, windowCopy = true, timing: SnapshotTiming = "now"): Promise<PageSnapshot | RefusedSnapshot | null> =>
  settled(() => pages.snapshot(id, { maxWidth: 600, quality: 72, ...(windowCopy ? {} : { windowCopy }), ...(timing === "quiet" ? { quiet: true } : {}) }), null);

export function snapshotIsCurrent(id: string): boolean | null {
  try {
    return pages.snapshotIsCurrent(id);
  } catch {
    return null;
  }
}

export const savePageState = (id: string): Promise<string | null> => settled(() => pages.saveState(id), null);

export const pageScrollPosition = (id: string): Promise<PageScrollPosition | null> => settled(() => pages.scrollPosition(id), null);

export const openPageInBackground = (id: string, url: string, isPrivate: boolean) => settled(() => pages.open(id, { url, isPrivate }), undefined);

export const livePageIds = (): Promise<string[]> => settled(() => pages.ids(), []);

export function listenToPages(listener: (event: PageEngineEvent) => void) {
  try {
    return pages.addListener(listener);
  } catch {
    return null;
  }
}
