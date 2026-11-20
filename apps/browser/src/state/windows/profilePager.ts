import { leadPager, morphPager, nativeMorph, pagerState, selectPager, stepPager, switchPager, type MorphConfig, type NativePagerConfig, type PagerSnapshot, type PagerStateEvent, type SwipeEvent } from "../../platform/pager";
import { notePagerSettle } from "../telemetry/pagerCounts";
import { noteLibraryOpenRefused } from "../telemetry/libraryCounts";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Animated, unstable_batchedUpdates } from "react-native";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { libraryOf, markLibraryOpen, useLibrary, type LibraryEntry, type LibraryExit } from "../library/library";
import { saveBeforeQuit } from "../app/quit";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { useLibraryAvailable, useLibraryOpen } from "../library/hooks";
import { setLibraryPagerDriver, setLibraryPagerIntent, type LibraryHeading } from "../library/pagerBridge";
import { libraryShowableIn } from "../library/showable";

export type PagerPage = { id: string; slot: number; resting?: boolean };
type LibraryCause = LibraryEntry | LibraryExit;
type LibraryRequest = { open: boolean; cause: LibraryCause; consent: ConsentToken | null; landed?: boolean };

function restPages(current: string | null, order: string[]): PagerPage[] {
  if (!current) return [];
  const i = order.indexOf(current);
  const before = i > 0 ? order[i - 1] : undefined;
  const after = i >= 0 ? order[i + 1] : undefined;
  return [...(before ? [{ id: before, slot: -1 }] : []), { id: current, slot: 0 }, ...(after ? [{ id: after, slot: 1 }] : [])];
}

const WHEEL_THRESHOLD = 1;
const WHEEL_BURST_MS = 49;
const WHEEL_COOLDOWN_MS = 250;

type NativeReport = PagerSnapshot | PagerStateEvent;
const selectionOf = (r: NativeReport) => ("selectionSequence" in r ? r.selectionSequence : r.sequence);

class ProfilePager {
  readonly pos: Animated.Value;
  readonly lead = new Animated.Value(0, { useNativeDriver: true });
  private nativeLeading = false;
  private libraryRequests: LibraryRequest[] = [];
  readonly state = create<{ pages: PagerPage[] | null; ack: number }>()(() => ({ pages: null, ack: 0 }));
  private surfaces = 0;
  private switching = false;
  private unsubscribe: () => void;
  private lastEvent: object | null = null;
  private wheelState = { sum: 0, last: 0, trigger: 0 };
  private external = 0;
  private externalGeneration = 0;
  private seen = 0;
  private switchedSinceBegan = false;
  private swiping = false;

  readonly windowId: string;

  constructor(windowId: string, watchesWindow = true) {
    this.windowId = windowId;
    this.pos = new Animated.Value(Math.max(0, this.index()), { useNativeDriver: true });
    this.state.setState({ pages: this.warmPages() });
    this.unsubscribe = watchesWindow ? this.watchWindow(windowId) : () => {};
  }

  private watchWindow(windowId: string) {
    return useBrowser.subscribe((s, prev) => {
      const w = s.windows[windowId];
      if (!w) return this.dispose();
      const was = prev.windows[windowId];
      if (w.profileId !== was?.profileId || (w.kind === "private") !== (was?.kind === "private") || s.profileOrder !== prev.profileOrder) {
        this.state.setState({ pages: this.warmPages() });
      }
      if (!this.switching && w.kind !== "private" && w.profileId !== was?.profileId) this.selectExternal(w.profileId, s.profileOrder);
    });
  }

  attach() {
    this.surfaces++;
    return () => void this.surfaces--;
  }

  readonly onNativeState = (event: PagerStateEvent) => {
    if (event.phase === "began") this.swiping = true;
    if (this.external) return;
    const snapshot = this.nativeSnapshot();
    this.commitNative(snapshot ?? event, event, consentToken());
    if (event.phase === "settled" || (event.phase === "selected" && snapshot?.phase === "idle")) this.swiping = false;
  };

  private selectExternal(profileId: string, order: string[]) {
    const index = order.indexOf(profileId);
    if (index >= 0) this.pos.setValue(index);
    const generation = ++this.externalGeneration;
    this.external = generation;
    const consent = consentToken();
    const done = () => {
      if (this.external !== generation) return;
      this.external = 0;
      this.commitNative(this.nativeSnapshot(), undefined, consent);
      this.libraryRequests = this.libraryRequests.filter((r) => !r.landed);
    };
    selectPager(this.windowId, profileId, order).then(done, done);
  }

  private commitNative(report: NativeReport | null, event?: PagerStateEvent, consent?: ConsentToken | null) {
    if (!report || report.sequence <= this.seen) return;
    this.seen = report.sequence;
    if (__DEV__) this.lastEvent = { native: event ?? null, snapshot: report };
    const s = useBrowser.getState();
    const w = s.windows[this.windowId];
    const id = report.profileId !== undefined ? report.profileId : s.profileOrder[report.selected];
    const switches = !!w && w.kind !== "private" && !!id && !!s.profiles[id] && id !== w.profileId;
    const ack = selectionOf(report);
    if (event?.phase === "began") this.switchedSinceBegan = false;
    if (event?.phase === "settled") notePagerSettle(this.switchedSinceBegan || switches);
    const leading = !!report.leading;
    if (!switches && ack <= this.state.getState().ack && leading === this.nativeLeading) return;
    unstable_batchedUpdates(() => {
      if (switches) {
        this.switchedSinceBegan = true;
        this.switching = true;
        try {
          s.switchProfile(this.windowId, id!);
        } finally {
          this.switching = false;
        }
      }
      this.commitLibrary(leading, consent);
      if (ack > this.state.getState().ack) this.state.setState({ ack });
    });
  }

  private nativeSnapshot() {
    const snapshot = pagerState(this.windowId);
    if (!snapshot) this.nativeLeading = false;
    return snapshot;
  }

  private get windowGone() {
    return !useBrowser.getState().windows[this.windowId];
  }

  private commitLibrary(leading: boolean, consent?: ConsentToken | null) {
    if (this.windowGone || leading === this.nativeLeading) return;
    this.nativeLeading = leading;
    const request = this.swiping ? undefined : this.libraryRequests.find((r) => r.open === leading);
    if (request) this.dropLibraryRequest(request);
    if (leading && !libraryShowableIn(this.windowId)) return this.leadBackClosed(request ? request.consent : consent);
    if (libraryOf(this.windowId).open !== leading) markLibraryOpen(this.windowId, leading, request?.cause ?? "swipe", request ? request.consent : consent);
  }

  private leadBackClosed(consent?: ConsentToken | null) {
    noteLibraryOpenRefused(consent);
    this.libraryRequests = this.libraryRequests.filter((r) => !r.open);
    void leadPager(this.windowId, false, false).catch(() => false);
  }

  settledLead(): number | null {
    const snapshot = pagerState(this.windowId);
    return snapshot?.phase === "idle" && typeof snapshot.lead === "number" ? Math.min(1, Math.max(0, snapshot.lead)) : null;
  }

  morph(config: MorphConfig | null): Promise<boolean> {
    return morphPager(this.windowId, config);
  }

  get drivesLibraryNatively() {
    return this.active && pagerState(this.windowId) !== null;
  }

  releaseLibraryForQuit(): boolean {
    const shown = this.nativeLeading || !!this.nativeSnapshot()?.leading || this.libraryRequests.some((r) => r.open);
    this.libraryRequests = [];
    this.nativeLeading = false;
    return shown;
  }

  get libraryHeading(): LibraryHeading | undefined {
    const request = this.libraryRequests.at(-1);
    if (request) return { open: request.open, cause: request.cause };
    if (!this.drivesLibraryNatively) return undefined;
    return { open: !!pagerState(this.windowId)?.leading, cause: "swipe" };
  }

  driveLibrary(open: boolean, cause: LibraryCause): boolean {
    if (!this.drivesLibraryNatively) return false;
    const consent = consentToken();
    if (!this.libraryRequests.length) {
      this.nativeLeading = !!this.nativeSnapshot()?.leading;
      if (this.nativeLeading === open) {
        if (libraryOf(this.windowId).open !== open) markLibraryOpen(this.windowId, open, cause, consent);
        return true;
      }
    }
    const request: LibraryRequest = { open, cause, consent };
    this.swiping = false;
    this.libraryRequests.push(request);
    let led: Promise<boolean>;
    try {
      led = leadPager(this.windowId, open);
    } catch {
      led = Promise.resolve(false);
    }
    led.then(
      (ok) => (ok ? this.landLibrary(request) : this.libraryFallback(request)),
      () => this.libraryFallback(request),
    );
    return true;
  }

  private dropLibraryRequest(request: LibraryRequest) {
    this.libraryRequests = this.libraryRequests.filter((r) => r !== request);
  }

  private landLibrary(request: LibraryRequest) {
    if (!this.libraryRequests.includes(request)) return;
    if (this.external) return void (request.landed = true);
    this.commitNative(this.nativeSnapshot(), undefined, request.consent);
    this.dropLibraryRequest(request);
  }

  private libraryFallback(request: LibraryRequest) {
    const superseded = this.libraryRequests.at(-1) !== request;
    this.dropLibraryRequest(request);
    if (superseded || this.windowGone || libraryOf(this.windowId).open === request.open) return;
    if (!request.open || libraryShowableIn(this.windowId)) markLibraryOpen(this.windowId, request.open, request.cause, request.consent);
  }

  private index() {
    const current = this.current();
    return current ? useBrowser.getState().profileOrder.indexOf(current) : -1;
  }

  private warmPages(): PagerPage[] | null {
    const i = this.index();
    if (i < 0) return null;
    const order = useBrowser.getState().profileOrder;
    return [i - 1, i, i + 1].filter((slot) => slot >= 0 && slot < order.length).map((slot) => ({ id: order[slot]!, slot }));
  }

  reapplyNativePosition() {
    this.pos.setOffset(0);
  }

  get active() {
    return this.surfaces > 0 && !!this.current();
  }

  wheel(e: SwipeEvent) {
    const now = Date.now();
    const w = this.wheelState;
    if (now - w.trigger <= WHEEL_COOLDOWN_MS) return;
    if (now - w.last > WHEEL_BURST_MS) w.sum = 0;
    w.last = now;
    w.sum += e.direction === "back" ? -e.distance : e.distance;
    if (Math.abs(w.sum) <= WHEEL_THRESHOLD) return;
    const delta = w.sum < 0 ? -1 : 1;
    w.sum = 0;
    w.trigger = now;
    this.step(delta);
  }

  step(delta: -1 | 1) {
    if (!this.current()) return;
    void stepPager(this.windowId, delta, false, useBrowser.getState().profileOrder).then((ok) => {
      if (ok) return;
      const next = useBrowser.getState().profileOrder[this.index() + delta];
      if (this.index() >= 0 && next) useBrowser.getState().switchProfile(this.windowId, next);
    });
  }

  switchTo(profileId: string) {
    const s = useBrowser.getState();
    const index = s.profileOrder.indexOf(profileId);
    if (!s.profiles[profileId] || !this.current() || index < 0) return;
    if (!this.active) return s.switchProfile(this.windowId, profileId);
    void switchPager(this.windowId, index, s.profileOrder).then((ok) => {
      if (!ok) useBrowser.getState().switchProfile(this.windowId, profileId);
    });
  }

  private current() {
    const w = useBrowser.getState().windows[this.windowId];
    return w && w.kind !== "private" ? w.profileId : null;
  }

  private dispose() {
    const closing = this.libraryRequests.filter((r) => !r.open).at(-1);
    this.libraryRequests = [];
    if (closing && libraryOf(this.windowId).open) markLibraryOpen(this.windowId, false, closing.cause, closing.consent);
    this.external = 0;
    this.externalGeneration++;
    this.unsubscribe();
    pagers.delete(this.windowId);
  }

  debug() {
    return { lastEvent: this.lastEvent, snapshot: pagerState(this.windowId), ack: this.state.getState().ack, seen: this.seen, surfaces: this.surfaces, warm: this.state.getState().pages };
  }
}

const pagers = new Map<string, ProfilePager>();

export function pagerFor(windowId: string): ProfilePager {
  let pager = pagers.get(windowId);
  if (pager) return pager;
  if (!useBrowser.getState().windows[windowId]) return new ProfilePager(windowId, false);
  pagers.set(windowId, (pager = new ProfilePager(windowId)));
  return pager;
}

async function hideLibrariesForQuit() {
  const consent = consentToken();
  const windowIds = [...new Set([...Object.keys(useLibrary.getState().windows), ...pagers.keys()])];
  const native: string[] = [];
  let changed = false;
  for (const windowId of windowIds) {
    const pager = pagers.get(windowId);
    const nativeShown = pager?.releaseLibraryForQuit() ?? false;
    if (!libraryOf(windowId).open && !nativeShown) continue;
    changed = true;
    markLibraryOpen(windowId, false, "quit", consent);
    if (!pager) continue;
    pager.lead.stopAnimation();
    pager.lead.setValue(0);
    if (nativeShown && pager.drivesLibraryNatively) native.push(windowId);
  }
  if (!changed) return;
  await Promise.all(native.map((windowId) => leadPager(windowId, false, false).catch(() => false)));
  await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
}

saveBeforeQuit(hideLibrariesForQuit);

setLibraryPagerDriver((windowId: string, open: boolean, cause?: LibraryCause) => pagers.get(windowId)?.driveLibrary(open, cause ?? "button") ?? false);
setLibraryPagerIntent((windowId: string) => pagers.get(windowId)?.libraryHeading);

export const pagerMorphsNatively = nativeMorph;

export function pageToProfile(windowId: string, profileId: string) {
  pagerFor(windowId).switchTo(profileId);
}

export function usePagerSurface(windowId: string) {
  useEffect(() => pagerFor(windowId).attach(), [windowId]);
}

export function usePagerPages(windowId: string): { pages: PagerPage[]; paging: boolean; pager: ProfilePager } {
  const pager = pagerFor(windowId);
  const current = useBrowser((s) => s.windows[windowId]?.profileId ?? null);
  const incognito = useBrowser((s) => s.windows[windowId]?.kind === "private");
  const order = useBrowser((s) => s.profileOrder);
  const all = !incognito && !!current && order.includes(current);
  const everyPage = useMemo(() => order.map((id, slot) => ({ id, slot })), [order]);
  const resting = useMemo(() => (all ? null : restPages(current, order).map((p) => (p.id === current ? p : { ...p, resting: true }))), [all, current, order]);
  return { pages: resting ?? everyPage, paging: all, pager };
}

export function usePagerNativeConfig(windowId: string, width?: number): NativePagerConfig | undefined {
  const pager = pagerFor(windowId);
  const ack = pager.state((s) => s.ack);
  const leading = useLibraryAvailable(windowId);
  const library = useLibraryOpen(windowId);
  const [selected, count, order] = useBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      const i = w && w.kind !== "private" ? s.profileOrder.indexOf(w.profileId) : -1;
      return [i, s.profileOrder.length, s.profileOrder] as const;
    }),
  );
  return useMemo(
    () => (selected >= 0 ? { key: windowId, selected, count, width: width || undefined, ack, order, leading, library } : undefined),
    [windowId, selected, count, width, ack, order, leading, library],
  );
}

export function useNativePagerPosition(windowId: string) {
  const pager = pagerFor(windowId);
  useLayoutEffect(() => pager.reapplyNativePosition());
}

export function usePageStyle(windowId: string, slot: number, width: number) {
  const { pos } = pagerFor(windowId);
  useNativePagerPosition(windowId);
  return useMemo(() => ({ translateX: Animated.multiply(Animated.add(pos, -slot), -width) }), [pos, slot, width]);
}

if (__DEV__) {
  (globalThis as { acPager?: unknown }).acPager = (windowId: string) => pagerFor(windowId);
}
