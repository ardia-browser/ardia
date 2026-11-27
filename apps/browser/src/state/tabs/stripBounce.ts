import type { BrowserState } from "../browser/store";
import { useMedia } from "../media/media";
import { consentToken, counted, queueLog, type ConsentToken } from "../telemetry/client";
import { switchingPress } from "./tabReveal";

const BOUNCE_WINDOW_MS = 2000;

const TRIGGER_KEYS = {
  didActivateTab: "did_activate_tab",
  didInsertTab: "did_insert_tab",
  didRemoveTab: "did_remove_tab",
  attach: "attach",
  groupObserver: "group_observer",
  none: "none",
  other: "other",
} as const;
type Trigger = keyof typeof TRIGGER_KEYS;
const triggerOf = (value: unknown): Trigger => (value === undefined || value === null ? "none" : typeof value === "string" && Object.hasOwn(TRIGGER_KEYS, value) ? (value as Trigger) : "other");

export type StripBounceContext = {
  trigger?: unknown;
  deferred?: boolean;
  deferredBehind?: number;
  msSinceAck?: number;
  inflight?: "activate" | "arrange" | "group";
  pendingActive?: boolean;
  hasSibling?: boolean;
  activeFallback?: boolean;
};

type Switch = { from: string; to: string; at: number; nativePress: boolean; consent: ConsentToken | null };

const lastSwitch = new Map<string, Switch>();
const emptyByTrigger = () => Object.fromEntries(Object.keys(TRIGGER_KEYS).map((t) => [t, 0])) as Record<Trigger, number>;
const empty = () => ({ back: 0, backWithPictureInPicture: 0, backAfterNativePress: 0, elsewhere: 0, backByTrigger: emptyByTrigger() });
let counts = empty();

const selectedIn = (s: BrowserState, windowId: string): string | undefined => {
  const w = s.windows[windowId];
  return w ? w.activeTabIds[w.profileId] : undefined;
};

function changedSelections(prev: BrowserState, s: BrowserState): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (prev.windows === s.windows) return out;
  for (const windowId of Object.keys(s.windows)) {
    const before = selectedIn(prev, windowId);
    const after = selectedIn(s, windowId);
    if (before && after && before !== after && prev.windows[windowId]?.profileId === s.windows[windowId]!.profileId) out.push([windowId, before, after]);
  }
  return out;
}

export function recordSelectionByApp(prev: BrowserState, s: BrowserState, consent: ConsentToken | null, now = Date.now()) {
  for (const [windowId, from, to] of changedSelections(prev, s)) lastSwitch.set(windowId, { from, to, at: now, nativePress: switchingPress() > 0, consent });
}

export const recordAppSelection = (prev: BrowserState, s: BrowserState) => recordSelectionByApp(prev, s, consentToken());

export function judgeStripSelection(prev: BrowserState, s: BrowserState, now = Date.now(), context: StripBounceContext = {}) {
  for (const [windowId, from, to] of changedSelections(prev, s)) {
    const last = lastSwitch.get(windowId);
    lastSwitch.delete(windowId);
    if (!last || from !== last.to || now - last.at > BOUNCE_WINDOW_MS) continue;
    const back = to === last.from;
    const pictureInPicture = back && !!useMedia.getState().pipOpen[to];
    const tile = s.tabs[to]?.pin?.as === "tile";
    const { consent } = last;
    const trigger = triggerOf(context.trigger);
    counted(consent, () => {
      if (!back) return void counts.elsewhere++;
      counts.back++;
      counts.backByTrigger[trigger]++;
      if (pictureInPicture) counts.backWithPictureInPicture++;
      if (last.nativePress) counts.backAfterNativePress++;
    });
    queueLog("warn", back ? "Chromium's tab strip selected the tab the user had just left" : "Chromium's tab strip selected another tab right after a switch", {
      ms: now - last.at, nativePress: last.nativePress, pictureInPicture, tile,
      trigger, deferred: context.deferred === true, inflight: context.inflight ?? "none", pendingActive: context.pendingActive === true,
      hasSibling: context.hasSibling === true, activeFallback: context.activeFallback === true,
      ...(typeof context.msSinceAck === "number" ? { msSinceAck: context.msSinceAck } : {}),
      ...(typeof context.deferredBehind === "number" ? { deferredBehind: context.deferredBehind } : {}),
    }, consent);
  }
}

export function takeStripBounceCounts() {
  const taken = counts;
  counts = empty();
  return {
    strip_bounces_back: taken.back,
    strip_bounces_back_pip: taken.backWithPictureInPicture,
    strip_bounces_back_native_press: taken.backAfterNativePress,
    strip_bounces_elsewhere: taken.elsewhere,
    ...Object.fromEntries(Object.entries(TRIGGER_KEYS).map(([trigger, key]) => [`strip_bounces_back_${key}`, taken.backByTrigger[trigger as Trigger]])),
  };
}
