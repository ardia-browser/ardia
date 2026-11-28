import { materializeTab } from "../../platform/tabs";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { refreshExtensions } from "../extensions/lists";
import { markMaterialized } from "./materialized";
import { hasTabAccess, materializeCandidates } from "./materializePlan";

const BATCH = 8;
const BATCH_DELAY_MS = 40;
const RETRY_MS = 1500;
const MAX_ATTEMPTS = 6;
const START_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const allowedWindows = async (s: BrowserState): Promise<Set<string>> => {
  const profiles = new Set<string>();
  for (const id of s.windowOrder) {
    const w = s.windows[id];
    if (w?.kind === "main" && !isIncognitoProfile(w.profileId)) profiles.add(engineProfile(s, w.profileId));
  }
  const access = new Map<string, boolean>();
  for (const profile of profiles) {
    const list = await refreshExtensions(profile).catch(() => []);
    access.set(profile, hasTabAccess(list));
  }
  const out = new Set<string>();
  for (const id of s.windowOrder) {
    const w = s.windows[id];
    if (w?.kind === "main" && access.get(engineProfile(s, w.profileId))) out.add(id);
  }
  return out;
};

async function materialize(attempt: number): Promise<void> {
  const first = useBrowser.getState();
  const allowed = await allowedWindows(first);
  if (!allowed.size) {
    if (attempt + 1 < MAX_ATTEMPTS) setTimeout(() => void materialize(attempt + 1), RETRY_MS);
    return;
  }
  let failed = false;

  for (const windowId of [...allowed]) {
    const s = useBrowser.getState();
    const w = s.windows[windowId];
    if (!w) continue;
    const profile = engineProfile(s, w.profileId);
    const tabs = materializeCandidates(s, windowId);
    for (let i = 0; i < tabs.length; i += BATCH) {
      for (const candidate of tabs.slice(i, i + BATCH)) {
        const tab = useBrowser.getState().tabs[candidate.id];
        if (!tab) continue;
        if (await materializeTab(tab.id, tab.url, profile, windowId)) markMaterialized(tab.id);
        else failed = true;
      }
      if (i + BATCH < tabs.length) await sleep(BATCH_DELAY_MS);
    }
  }

  const now = useBrowser.getState();
  const left = [...allowed].some((id) => materializeCandidates(now, id).length > 0);
  if ((failed || left) && attempt + 1 < MAX_ATTEMPTS) {
    setTimeout(() => void materialize(attempt + 1), RETRY_MS);
  }
}

let started = false;

export function startMaterializeRestoredTabs(): void {
  if (started) return;
  started = true;
  setTimeout(() => void materialize(0), START_DELAY_MS);
}
