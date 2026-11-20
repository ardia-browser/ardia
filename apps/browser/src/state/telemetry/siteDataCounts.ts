import type { PageEngine } from "../../platform/tabs";
import { counted, onConsentPeriodChange, type ConsentToken } from "./choice";

const none = () => ({
  site_data_carries_to_webkit: 0,
  site_data_carries_to_chromium: 0,
  site_data_cookies_to_webkit: 0,
  site_data_cookies_to_chromium: 0,
  site_data_cookies_removed: 0,
  site_data_storage_to_webkit: 0,
  site_data_storage_to_chromium: 0,
  site_data_conflicts: 0,
  site_data_gate_holds: 0,
  site_data_gate_fresh: 0,
  site_data_gate_ms_total: 0,
  site_data_gate_ms_max: 0,
  site_data_gate_timeouts: 0,
  site_data_blocked: 0,
  site_data_chromium_unreadable: 0,
  site_data_cookie_only_fallbacks: 0,
  site_data_failures: 0,
  site_data_untrusted_drops: 0,
  site_data_clear_wait_timeouts: 0,
  site_data_sites_unresolved: 0,
});

let tally = none();

onConsentPeriodChange(() => (tally = none()));

export type SiteDataCarry = { cookies: number; removed: number; storage: number; conflicts: number };

export function noteSiteDataCarry(to: PageEngine, carry: SiteDataCarry, consent: ConsentToken | null) {
  if (carry.cookies + carry.removed + carry.storage === 0) return;
  counted(consent, () => addCarry(to, carry));
}

function addCarry(to: PageEngine, carry: SiteDataCarry) {
  tally[to === "webkit" ? "site_data_carries_to_webkit" : "site_data_carries_to_chromium"]++;
  tally[to === "webkit" ? "site_data_cookies_to_webkit" : "site_data_cookies_to_chromium"] += carry.cookies;
  tally[to === "webkit" ? "site_data_storage_to_webkit" : "site_data_storage_to_chromium"] += carry.storage;
  tally.site_data_cookies_removed += carry.removed;
  tally.site_data_conflicts += carry.conflicts;
}

export function noteSiteDataGate(ms: number, gate: { held: boolean; timedOut: boolean }, consent: ConsentToken | null) {
  counted(consent, () => addGate(ms, gate));
}

function addGate(ms: number, { held, timedOut }: { held: boolean; timedOut: boolean }) {
  if (!held) return void tally.site_data_gate_fresh++;
  const rounded = Math.max(0, Math.round(ms));
  tally.site_data_gate_holds++;
  tally.site_data_gate_ms_total += rounded;
  tally.site_data_gate_ms_max = Math.max(tally.site_data_gate_ms_max, rounded);
  if (timedOut) tally.site_data_gate_timeouts++;
}

const SKIP_FIELDS = {
  blocked: "site_data_blocked",
  chromiumUnreadable: "site_data_chromium_unreadable",
  cookieOnlyFallback: "site_data_cookie_only_fallbacks",
  failure: "site_data_failures",
  untrustedDrops: "site_data_untrusted_drops",
  clearWaitTimeout: "site_data_clear_wait_timeouts",
  siteUnresolved: "site_data_sites_unresolved",
} as const;

export function noteSiteDataSkip(reason: keyof typeof SKIP_FIELDS, consent: ConsentToken | null) {
  counted(consent, () => void tally[SKIP_FIELDS[reason]]++);
}

export function takeSiteDataCounts() {
  const taken = tally;
  tally = none();
  return taken;
}
