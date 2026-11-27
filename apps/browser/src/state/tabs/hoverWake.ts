import { webviews } from "../../platform/webviews";
import { isWebPageUrl } from "../../lib/url";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { holderOf } from "../pins/pinShare";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { noteHoverWakePutBack, noteHoverWokenTabOpened, noteTabWokenOnHover } from "../telemetry/tabSleepCounts";
import { heldByCli } from "./cliHolds";
import { inUse } from "./loadedTabBudget";
import { hasPage, restoredLazily, wokenPage } from "./pageSession";
import { askToSleep, sleepAskedNow } from "./sleepAsks";
import { shownTabIds } from "./shownTabs";
import { isSleeping, markSleeping, useLifecycle, wasSleptByHand } from "./sleepingTabs";
import { liveOf } from "./tabLive";
import type { MemoryPressure } from "./sleepPolicy";

export const HOVER_WAKE_MS = 150;
export const HOVER_WAKE_OPENED_WITHIN_MS = 10_000;
export const HOVER_WAKE_KEPT_MS = 2 * 60_000;

export type HoverWake = "discarded" | "unloaded" | null;

export type HoverWakeFacts = {
  exists: boolean;
  shown: boolean;
  memorySaver: boolean;
  discarded: boolean;
  sleptByHand: boolean;
  hasView: boolean;
  restoredLazily: boolean;
  webPage: boolean;
  chromium: boolean;
  privateProfile: boolean;
  held: boolean;
  pressure: MemoryPressure;
  batterySaver: boolean;
};

export function hoverWakeOf(f: HoverWakeFacts): HoverWake {
  if (!f.exists || f.shown || !f.memorySaver || f.pressure !== "normal" || f.batterySaver || !f.chromium || f.privateProfile) return null;
  if (f.discarded) return f.hasView && !f.sleptByHand ? "discarded" : null;
  return f.restoredLazily && f.webPage && !f.held ? "unloaded" : null;
}

function factsOf(s: BrowserState, id: string): HoverWakeFacts {
  const t = s.tabs[id];
  const life = useLifecycle.getState();
  return {
    exists: !!t,
    shown: shownTabIds(s).has(id),
    memorySaver: s.settings.memorySaver !== false,
    discarded: !!life.discarded[id],
    sleptByHand: wasSleptByHand(id),
    hasView: webviews.has(id),
    restoredLazily: !!t && restoredLazily(t),
    webPage: !!t && isWebPageUrl(t.url),
    chromium: !!t && tabEngine(s, id) === "chromium",
    privateProfile: !!t && isIncognitoProfile(engineProfile(s, t.profileId)),
    held: !!holderOf(s, id),
    pressure: life.memoryPressure,
    batterySaver: life.batterySaver,
  };
}

type Wake = {
  at: number;
  consent: ConsentToken | null;
  kind: Exclude<HoverWake, null>;
  inFlight: boolean;
  openedAt?: number;
  putBack?: ReturnType<typeof setTimeout>;
};

const woken = new Map<string, Wake>();
let timer: ReturnType<typeof setTimeout> | undefined;
let armedId: string | null = null;
let watching = false;

function forgetWake(id: string, wake: Wake) {
  if (woken.get(id) !== wake) return false;
  woken.delete(id);
  clearTimeout(wake.putBack);
  return true;
}

export function noteHoverWakeOpened(tabId: string | undefined, now = Date.now()): boolean {
  const wake = tabId ? woken.get(tabId) : undefined;
  if (!tabId || !wake) return false;
  if (wake.inFlight) {
    wake.openedAt ??= now;
    return true;
  }
  forgetWake(tabId, wake);
  if (now - wake.at > HOVER_WAKE_OPENED_WITHIN_MS) return false;
  noteHoverWokenTabOpened(wake.consent);
  return true;
}

export async function putBackHoverWake(id: string, wake: Pick<Wake, "consent">): Promise<boolean> {
  const s = useBrowser.getState();
  const t = s.tabs[id];
  const view = webviews.get(id);
  if (!t || !view || !hasPage(t) || isSleeping(id) || sleepAskedNow(id) || shownTabIds(s).has(id) || inUse(s, id) || heldByCli(id) || liveOf(id).isLoading) return false;
  let slept = false;
  await askToSleep(id, () => view.sleepIfHidden(0), ({ keptBy, awakeMeanwhile }) => {
    if (!keptBy || keptBy.length) return;
    if (!awakeMeanwhile) markSleeping(id);
    noteHoverWakePutBack(wake.consent);
    slept = true;
  });
  return slept;
}

function putBack(id: string, wake: Wake) {
  if (forgetWake(id, wake)) void putBackHoverWake(id, wake);
}

export function noteHoverWakesShown(shown: ReadonlySet<string>, now = Date.now()) {
  for (const id of [...woken.keys()]) if (shown.has(id)) noteHoverWakeOpened(id, now);
}

function watchOpens() {
  if (watching) return;
  watching = true;
  useBrowser.subscribeTo(["windows", "splits", "peeks", "tabs"], (s) => {
    if (woken.size) noteHoverWakesShown(shownTabIds(s));
  });
}

export function forgetHoverWakes() {
  for (const [id, wake] of [...woken]) forgetWake(id, wake);
  cancelHoverWake();
}

export async function wakeOnHover(id: string, consent: ConsentToken | null, now = Date.now()): Promise<HoverWake> {
  if (woken.has(id)) return null;
  const s = useBrowser.getState();
  const kind = hoverWakeOf(factsOf(s, id));
  if (!kind) return null;
  const wake: Wake = { at: now, consent, kind, inFlight: true };
  woken.set(id, wake);
  watchOpens();
  if (kind === "discarded") {
    const woke = await Promise.resolve(webviews.get(id)?.wakeIfSleeping?.()).catch(() => false);
    wake.inFlight = false;
    if (!woke) {
      forgetWake(id, wake);
      return null;
    }
  } else {
    s.updateTab(id, { page: wokenPage(s.tabs[id]!) });
    wake.inFlight = false;
  }
  noteTabWokenOnHover(consent);
  if (wake.openedAt !== undefined) {
    forgetWake(id, wake);
    if (wake.openedAt - wake.at <= HOVER_WAKE_OPENED_WITHIN_MS) noteHoverWokenTabOpened(consent);
  } else if (woken.get(id) === wake) wake.putBack = setTimeout(() => putBack(id, wake), HOVER_WAKE_KEPT_MS);
  return kind;
}

export function cancelHoverWake(onlyFor?: string) {
  if (onlyFor !== undefined && onlyFor !== armedId) return;
  clearTimeout(timer);
  timer = undefined;
  armedId = null;
}

export function armHoverWake(id: string) {
  if (!PLATFORM_FEATURES.wakesSleepingTabsOnHover || armedId === id) return;
  cancelHoverWake();
  armedId = id;
  const consent = consentToken();
  timer = setTimeout(() => {
    timer = undefined;
    armedId = null;
    void wakeOnHover(id, consent);
  }, HOVER_WAKE_MS);
}
