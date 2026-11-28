import type { ArdiaHost } from "./host";
import { reportHostError, shellProfile } from "./host.ts";
import type { AdoptId, BrowserWindow, Profile } from "../../browser/src/state/browser/types";
import { engineProfile } from "../../browser/src/state/browser/model";
import type { NewTabOptions } from "../../browser/src/state/tabs/tabs";
import { asAdoptId } from "../../browser/src/state/tabs/adoptIds";
import { noteUnclaimedTab } from "../../browser/src/state/telemetry/windowPlacementCounts";
import { consentToken, type ConsentToken } from "../../browser/src/state/telemetry/client";

const COUNTED_DROPS_LIMIT = 512;

export type UnclaimedTab = { adoptId: string; url: string; active: boolean; profile?: string };

type TabStore = {
  getState(): {
    windows: Record<string, BrowserWindow | undefined>;
    profiles: Record<string, Profile | undefined>;
    profileOrder: string[];
    newTab(windowId: string, options?: NewTabOptions): string;
  };
};

export function unclaimedAdoptId(offer: unknown): AdoptId | undefined {
  if (!offer || typeof offer !== "object") return undefined;
  const { adoptId, url } = offer as Partial<UnclaimedTab>;
  return typeof url === "string" && typeof adoptId === "string" && /^tab:\d+$/.test(adoptId) ? asAdoptId(adoptId) : undefined;
}

type ProfileState = { profiles: Record<string, Profile | undefined>; profileOrder: string[] };

function offeredProfile(s: ProfileState, w: BrowserWindow, engine: unknown): string | undefined {
  if (typeof engine !== "string" || w.kind === "private") return w.profileId;
  const known = s as Parameters<typeof engineProfile>[0];
  if (engineProfile(known, w.profileId) === engine) return w.profileId;
  const candidates = [...Object.keys(w.activeTabIds), ...s.profileOrder];
  return candidates.find((id) => !!s.profiles[id] && engineProfile(known, id) === engine);
}

type UnclaimedOutcome = "adopted" | "dropped";

export function adoptUnclaimedTab(store: TabStore, windowId: string, offer: unknown, host?: Pick<ArdiaHost, "bootstrap">, note?: (outcome: UnclaimedOutcome) => void) {
  const adoptId = unclaimedAdoptId(offer);
  const s = store.getState();
  const w = s.windows[windowId];
  if (!adoptId || !w) return undefined;
  const { url, active, profile } = offer as UnclaimedTab;
  const profileId = offeredProfile(s, w, typeof profile === "string" && host ? shellProfile(profile, host) : profile);
  if (!profileId) {
    note?.("dropped");
    return undefined;
  }
  note?.("adopted");
  return s.newTab(windowId, { url: url || undefined, adoptId, profileId, background: active !== true || w.kind === "small" || profileId !== w.profileId });
}

export function watchUnclaimedTabs(host: ArdiaHost, store: TabStore, windowId = host.bootstrap.windowId) {
  let stopped = false;
  const adopted = new Set<string>();
  const dropped = new Set<string>();
  const adopt = (offer: unknown, consent: ConsentToken | null) => {
    const adoptId = unclaimedAdoptId(offer);
    if (stopped || !adoptId || adopted.has(adoptId)) return;
    const note = (outcome: UnclaimedOutcome) => {
      if (outcome === "dropped" && dropped.has(adoptId)) return;
      if (outcome === "dropped") {
        if (dropped.size >= COUNTED_DROPS_LIMIT) dropped.clear();
        dropped.add(adoptId);
      }
      noteUnclaimedTab(outcome, consent);
    };
    if (adoptUnclaimedTab(store, windowId, offer, host, note)) adopted.add(adoptId);
  };
  const stopEvents = host.onEvent((module, event, payload) => {
    if (module === "ArdiaTabs" && event === "unclaimed") adopt(payload, consentToken());
  });
  const listConsent = consentToken();
  void Promise.resolve(host.invoke("ArdiaTabs.unclaimedTabs", { args: [] })).then((tabs) => {
    if (Array.isArray(tabs)) for (const offer of tabs) adopt(offer, listConsent);
  }).catch((error) => { if (!stopped) reportHostError(error); });
  return () => {
    stopped = true;
    stopEvents();
  };
}
