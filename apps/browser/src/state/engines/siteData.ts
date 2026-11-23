import { onWebKitSiteCookiesChanged, onWebKitSiteDataWanted, releaseWebKitSiteDataGate, watchWebKitSiteData, type PageCookie } from "../../platform/webkit";
import { withDeadline } from "../../lib/deadline";
import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { forgetRegistrableDomains, siteOfOrigin, webOrigin } from "./siteDataMerge";
import { learnRegistrableDomains, resetRegistrableLookupsForTest } from "./siteDataDomains";
import { addHop, touch } from "./siteDataLedger";
import { book, hostOf, resetSiteDataStateForTest, saveSoon } from "./siteDataState";
import { carriesSiteData, carrySoon, knownSites, liveTabs, prepareWebKitLoad, pushSoon, resetCarriesForTest, webKitInUse } from "./siteDataCarry";
import { noteSiteDataGate } from "../telemetry/siteDataCounts";
import { consentToken } from "../telemetry/client";
import { nativeConsent } from "../telemetry/nativeConsent";

export { carriesSiteData, carryForTab, carryRecentSites, carrySite } from "./siteDataCarry";
export { clearSiteDataEverywhere, forgetSiteDataProfile, whileClearingSiteData } from "./siteDataState";

const GATE_DEADLINE_MS = 450;
const SCAN_DELAY_MS = 300;
const PUSH_DELAY_MS = 400;
const SETTLE_PUSH_MS = 3_000;
const HOP_WINDOW_MS = 3 * 60_000;

const store = () => useBrowser.getState();

export function noteWebKitPageSettled(tabId: string, url: string, loading: boolean) {
  const s = store();
  const t = s.tabs[tabId];
  const origin = webOrigin(url);
  if (loading || !t || !origin || isIncognitoProfile(t.profileId) || !carriesSiteData()) return;
  const profile = engineProfile(s, t.profileId);
  const consent = consentToken();
  void learnRegistrableDomains([hostOf(origin)]).then(() => {
    const site = siteOfOrigin(origin);
    if (site) pushSoon(profile, site, SETTLE_PUSH_MS, consent);
  });
}

const tabSites = new Map<string, { site: string; at: number }[]>();
const tabUrls = new Map<string, string>();
let scanTimer: ReturnType<typeof setTimeout> | null = null;

const scanSiteData = () => void scan();

async function scan() {
  const consent = consentToken();
  const before = store();
  const hosts: string[] = [];
  for (const t of Object.values(before.tabs)) {
    const origin = t.url && !isIncognitoProfile(t.profileId) ? webOrigin(t.url) : null;
    if (origin) hosts.push(hostOf(origin));
  }
  await learnRegistrableDomains(hosts);
  scanTimer = null;
  const now = Date.now();
  let changed = false;
  const seen = new Set<string>();
  const s = store();
  for (const live of liveTabs(s)) {
    seen.add(live.tabId);
    if (!webKitInUse(live.profile, s)) continue;
    const url = s.tabs[live.tabId]?.url ?? "";
    const origin = webOrigin(url);
    if (tabUrls.get(live.tabId) !== url) {
      tabUrls.set(live.tabId, url);
      if (live.engine === "chromium" && carriesSiteData(s)) carrySoon(live.profile, live.site, "webkit", SETTLE_PUSH_MS, consent);
    }
    if (touch(book(), live.profile, live.site, live.engine, now, origin)) changed = true;
    const trail = tabSites.get(live.tabId) ?? [];
    if (trail[trail.length - 1]?.site !== live.site) {
      trail.push({ site: live.site, at: now });
      if (trail.length > 3) trail.shift();
      tabSites.set(live.tabId, trail);
      const [a, b, c] = trail;
      if (a && b && c && a.site === c.site && b.site !== c.site && now - a.at < HOP_WINDOW_MS && addHop(book(), live.profile, c.site, b.site)) changed = true;
    }
  }
  for (const id of tabSites.keys()) if (!seen.has(id)) tabSites.delete(id);
  for (const id of tabUrls.keys()) if (!seen.has(id)) tabUrls.delete(id);
  if (changed) saveSoon(consent);
}

let started = false;

export function startSiteData() {
  if (started) return;
  started = true;
  onWebKitSiteDataWanted((wanted) => {
    const { id, profile, origin } = wanted;
    const consent = nativeConsent(wanted);
    const began = Date.now();
    void prepareWebKitLoad(profile, origin, consent)
      .catch(() => null)
      .then(async (running) => {
        if (running) {
          const left = Math.max(0, GATE_DEADLINE_MS - (Date.now() - began));
          const done = await withDeadline(running.carry.then(() => true), left, false);
          noteSiteDataGate(Date.now() - began, { held: true, timedOut: !done }, consent);
        } else noteSiteDataGate(0, { held: false, timedOut: false }, consent);
        void releaseWebKitSiteDataGate(id).catch(() => {});
      });
  });
  onWebKitSiteCookiesChanged((changed) => {
    const { profile, domains } = changed;
    if (!carriesSiteData()) return;
    const consent = nativeConsent(changed);
    void learnRegistrableDomains(domains).then(() => {
      for (const site of knownSites(profile, domains)) pushSoon(profile, site, PUSH_DELAY_MS, consent);
    });
  });
  let watching = carriesSiteData();
  void watchWebKitSiteData(watching).catch(() => {});
  useBrowser.subscribeTo(["settings", "tabs"], (s, prev) => {
    if (s.settings !== prev.settings && carriesSiteData(s) !== watching) {
      watching = carriesSiteData(s);
      void watchWebKitSiteData(watching).catch(() => {});
    }
    if (s.tabs === prev.tabs || scanTimer) return;
    scanTimer = setTimeout(scanSiteData, SCAN_DELAY_MS);
  });
}

export const resetSiteDataForTest = () => {
  resetSiteDataStateForTest();
  resetCarriesForTest();
  forgetRegistrableDomains();
  resetRegistrableLookupsForTest();
};
export type { PageCookie };
