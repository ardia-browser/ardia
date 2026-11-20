import type { ArdiaHost } from "./host";
import { reportHostError } from "./host.ts";
import type { AdoptId, BrowserWindow, Profile, Space } from "../../browser/src/state/browser/types";
import { engineProfile } from "../../browser/src/state/browser/model";
import type { NewTabOptions } from "../../browser/src/state/tabs/tabs";
import { asAdoptId } from "../../browser/src/state/tabs/adoptIds";

export type UnclaimedTab = { adoptId: string; url: string; active: boolean; profile?: string };

type TabStore = {
  getState(): {
    windows: Record<string, BrowserWindow | undefined>;
    profiles: Record<string, Profile>;
    spaces: Record<string, Space>;
    spaceOrder: string[];
    newTab(windowId: string, options?: NewTabOptions): string;
  };
};

export function unclaimedAdoptId(offer: unknown): AdoptId | undefined {
  if (!offer || typeof offer !== "object") return undefined;
  const { adoptId, url } = offer as Partial<UnclaimedTab>;
  return typeof url === "string" && typeof adoptId === "string" && /^tab:\d+$/.test(adoptId) ? asAdoptId(adoptId) : undefined;
}

type ProfileState = { profiles: Record<string, Profile>; spaces: Record<string, Space>; spaceOrder: string[] };

export function offeredProfile(s: ProfileState, w: BrowserWindow, engine: unknown): string | undefined {
  if (typeof engine !== "string" || w.kind === "private") return w.spaceId;
  if (engineProfile(s, w.spaceId) === engine) return w.spaceId;
  const candidates = [...Object.keys(w.activeTabIds), ...s.spaceOrder];
  return candidates.find((id) => !!s.spaces[id] && engineProfile(s, id) === engine);
}

export function adoptUnclaimedTab(store: TabStore, windowId: string, offer: unknown) {
  const adoptId = unclaimedAdoptId(offer);
  const s = store.getState();
  const w = s.windows[windowId];
  if (!adoptId || !w) return undefined;
  const { url, active } = offer as UnclaimedTab;
  const profileId = offeredProfile(s, w, (offer as UnclaimedTab).profile);
  if (!profileId) return undefined;
  return s.newTab(windowId, { url: url || undefined, adoptId, spaceId: profileId, background: active !== true || w.kind === "small" || profileId !== w.spaceId });
}

export function watchUnclaimedTabs(host: ArdiaHost, store: TabStore, windowId = host.bootstrap.windowId) {
  let stopped = false;
  const adopted = new Set<string>();
  const adopt = (offer: unknown) => {
    const adoptId = unclaimedAdoptId(offer);
    if (stopped || !adoptId || adopted.has(adoptId)) return;
    if (adoptUnclaimedTab(store, windowId, offer)) adopted.add(adoptId);
  };
  const stopEvents = host.onEvent((module, event, payload) => {
    if (module === "ArdiaTabs" && event === "unclaimed") adopt(payload);
  });
  void Promise.resolve(host.invoke("ArdiaTabs.unclaimedTabs", { args: [] })).then((tabs) => {
    if (Array.isArray(tabs)) for (const offer of tabs) adopt(offer);
  }).catch((error) => { if (!stopped) reportHostError(error); });
  return () => {
    stopped = true;
    stopEvents();
  };
}
