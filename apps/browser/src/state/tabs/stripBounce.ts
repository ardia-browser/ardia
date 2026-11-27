import type { StripTrigger, TabStripCommand } from "../../platform/tabs";
import type { BrowserState } from "../browser/store";
import { useMedia } from "../media/media";
import { consentToken, counted, queueLog, type ConsentToken } from "../telemetry/client";
import { switchingPress } from "./tabReveal";

const BOUNCE_WINDOW_MS = 2000;
const TRIGGERS = ["activate", "insert", "remove", "attach", "observer", "closed", "unknown"] as const satisfies readonly (StripTrigger | "unknown")[];

type Switch = { from: string; to: string; at: number; nativePress: boolean; consent: ConsentToken | null };

export type StripNote = {
  trigger: StripTrigger | "unknown";
  deferred: boolean;
  deferredInferred: boolean;
  deferredFor: "lastAck" | "inflight" | "older" | "none";
  activeFallback: boolean;
  sinceAckMs: number;
  inflight: TabStripCommand["op"] | "none";
  pendingActive: boolean;
  siblings: boolean;
};

const UNKNOWN_NOTE: StripNote = {
  trigger: "unknown", deferred: false, deferredInferred: false, deferredFor: "none", activeFallback: false, sinceAckMs: -1, inflight: "none", pendingActive: false, siblings: false,
};

const lastSwitch = new Map<string, Switch>();
const byTrigger = () => Object.fromEntries(TRIGGERS.map((t) => [t, 0])) as Record<(typeof TRIGGERS)[number], number>;
const empty = () => ({ back: 0, backWithPictureInPicture: 0, backAfterNativePress: 0, backDeferred: 0, backActiveFallback: 0, backBy: byTrigger(), elsewhere: 0 });
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

export const switchedWindows = (prev: BrowserState, s: BrowserState) => changedSelections(prev, s).map(([windowId]) => windowId);

export function recordSelectionByApp(prev: BrowserState, s: BrowserState, consent: ConsentToken | null, now = Date.now()) {
  for (const [windowId, from, to] of changedSelections(prev, s)) lastSwitch.set(windowId, { from, to, at: now, nativePress: switchingPress() > 0, consent });
}

export const recordAppSelection = (prev: BrowserState, s: BrowserState) => recordSelectionByApp(prev, s, consentToken());

export function judgeStripSelection(prev: BrowserState, s: BrowserState, now = Date.now(), notes: ReadonlyMap<string, StripNote> = new Map()) {
  for (const [windowId, from, to] of changedSelections(prev, s)) {
    const last = lastSwitch.get(windowId);
    lastSwitch.delete(windowId);
    if (!last || from !== last.to || now - last.at > BOUNCE_WINDOW_MS) continue;
    const back = to === last.from;
    const pictureInPicture = back && !!useMedia.getState().pipOpen[to];
    const tile = s.tabs[to]?.pin?.as === "tile";
    const note = notes.get(windowId) ?? UNKNOWN_NOTE;
    const { consent } = last;
    counted(consent, () => {
      if (!back) return void counts.elsewhere++;
      counts.back++;
      counts.backBy[note.trigger]++;
      if (pictureInPicture) counts.backWithPictureInPicture++;
      if (last.nativePress) counts.backAfterNativePress++;
      if (note.deferred) counts.backDeferred++;
      if (note.activeFallback) counts.backActiveFallback++;
    });
    queueLog("warn", back ? "Chromium's tab strip selected the tab the user had just left" : "Chromium's tab strip selected another tab right after a switch", {
      ms: now - last.at, nativePress: last.nativePress, pictureInPicture, tile, ...note,
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
    strip_bounces_back_deferred: taken.backDeferred,
    strip_bounces_back_active_fallback: taken.backActiveFallback,
    ...(Object.fromEntries(TRIGGERS.map((t) => [`strip_bounces_back_${t}`, taken.backBy[t]])) as Record<`strip_bounces_back_${(typeof TRIGGERS)[number]}`, number>),
    strip_bounces_elsewhere: taken.elsewhere,
  };
}
