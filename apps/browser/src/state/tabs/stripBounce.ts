import type { BrowserState } from "../browser/store";
import { useMedia } from "../media/media";
import { consentToken, counted, queueLog, type ConsentToken } from "../telemetry/client";
import { switchingPress } from "./tabReveal";

const BOUNCE_WINDOW_MS = 2000;

type Switch = { from: string; to: string; at: number; nativePress: boolean; consent: ConsentToken | null };

const lastSwitch = new Map<string, Switch>();
const empty = () => ({ back: 0, backWithPictureInPicture: 0, backAfterNativePress: 0, elsewhere: 0 });
let counts = empty();

const selectedIn = (s: BrowserState, windowId: string): string | undefined => {
  const w = s.windows[windowId];
  return w ? w.activeTabIds[w.profileId] : undefined;
};

function changedSelections(prev: BrowserState, s: BrowserState, sameProfile: boolean): [string, string, string, boolean][] {
  const out: [string, string, string, boolean][] = [];
  if (prev.windows === s.windows) return out;
  for (const windowId of Object.keys(s.windows)) {
    const before = selectedIn(prev, windowId);
    const after = selectedIn(s, windowId);
    const otherProfile = prev.windows[windowId]?.profileId !== s.windows[windowId]!.profileId;
    if (before && after && before !== after && (!sameProfile || !otherProfile)) out.push([windowId, before, after, otherProfile]);
  }
  return out;
}

export function recordSelectionByApp(prev: BrowserState, s: BrowserState, consent: ConsentToken | null, now = Date.now()) {
  for (const [windowId, from, to] of changedSelections(prev, s, true)) lastSwitch.set(windowId, { from, to, at: now, nativePress: switchingPress() > 0, consent });
}

export const recordAppSelection = (prev: BrowserState, s: BrowserState) => recordSelectionByApp(prev, s, consentToken());

export function judgeStripSelection(prev: BrowserState, s: BrowserState, now = Date.now()) {
  for (const [windowId, from, to, otherProfile] of changedSelections(prev, s, false)) {
    const last = lastSwitch.get(windowId);
    lastSwitch.delete(windowId);
    if (!last || from !== last.to || now - last.at > BOUNCE_WINDOW_MS) continue;
    const back = to === last.from;
    const pictureInPicture = back && !!useMedia.getState().pipOpen[to];
    const tile = s.tabs[to]?.pin?.as === "tile";
    const { consent } = last;
    counted(consent, () => {
      if (!back) return void counts.elsewhere++;
      counts.back++;
      if (pictureInPicture) counts.backWithPictureInPicture++;
      if (last.nativePress) counts.backAfterNativePress++;
    });
    queueLog("warn", back ? "Chromium's tab strip selected the tab the user had just left" : "Chromium's tab strip selected another tab right after a switch", {
      ms: now - last.at, nativePress: last.nativePress, pictureInPicture, tile, ...(otherProfile ? { otherProfile: true } : {}),
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
  };
}
