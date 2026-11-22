import { urlParts } from "../../lib/urlParts";
import { isLocalOrigin, switchOrigin } from "../../lib/pluginPageBar";
import { pageBarsWanted } from "./chrome";
import { useBrowser } from "../browser/store";
import { openingSignal, openingAdmitted } from "../tabs/openingGate";
import { consentNow, type ConsentToken } from "../telemetry/choice";

const TYPED_INTENT_MS = 20_000;
type Intent = { url: string; origin: string; at: number; consent: ConsentToken | null; exact: number | null; held: { signal: AbortSignal; before: number | undefined } | null };
const typed = new Map<string, Intent>();

function documentUrl(url: string): string {
  const origin = switchOrigin(url);
  const parts = urlParts(url);
  return origin && parts ? `${origin}${parts.path || "/"}${parts.query}` : url.replace(/#.*$/, "");
}

const navigationOf = (tabId: string) => {
  const tab = useBrowser.getState().tabs[tabId];
  return tab?.page.kind === "loaded" || tab?.page.kind === "adopted" ? tab.page.nav : null;
};

function dropExpired(now: number) {
  const tabs = useBrowser.getState().tabs;
  for (const [tabId, intent] of typed) if (now - intent.at > TYPED_INTENT_MS || !Object.hasOwn(tabs, tabId)) typed.delete(tabId);
}

function note(tabId: string, url: string, exact: number | null, now: number, held: Intent["held"] = null): Intent | null {
  dropExpired(now);
  const origin = tabId && pageBarsWanted() ? switchOrigin(url) : null;
  if (!origin || !isLocalOrigin(origin)) return void typed.delete(tabId), null;
  const intent = { url: documentUrl(url), origin, at: now, consent: consentNow(), exact, held };
  typed.set(tabId, intent);
  return intent;
}

export function navigateTyped(tabId: string, url: string, navigate: () => void, now = Date.now()) {
  const before = navigationOf(tabId)?.seq;
  navigate();
  const started = navigationOf(tabId)?.seq;
  if (started !== undefined && started !== before) return void note(tabId, url, started, now);
  const signal = openingSignal(`tab:${tabId}`);
  if (signal) note(tabId, url, null, now, { signal, before });
  else typed.delete(tabId);
}

export function noteTypedOpen(tabId: string, url: string, now = Date.now()) {
  const exact = tabId ? navigationOf(tabId)?.seq : undefined;
  if (exact === undefined) return void typed.delete(tabId);
  note(tabId, url, exact, now);
}

export const dropTypedAddress = (tabId: string) => void typed.delete(tabId);

export const dropAllTypedAddresses = () => typed.clear();

export const typedAddressCount = () => typed.size;

export function takeTypedAddress(tabId: string, committedUrl: string, committedAt: number, now = Date.now()): { origin: string; consent: ConsentToken | null } | null {
  const intent = typed.get(tabId);
  if (!intent || !(committedAt > 0) || committedAt < intent.at) return null;
  typed.delete(tabId);
  if (now - intent.at > TYPED_INTENT_MS || documentUrl(committedUrl) !== intent.url || switchOrigin(committedUrl) !== intent.origin) return null;
  const nav = navigationOf(tabId);
  if (!nav || documentUrl(nav.url) !== intent.url) return null;
  const admitted = intent.held && openingAdmitted(intent.held.signal) && nav.seq !== intent.held.before;
  if (intent.exact !== null ? nav.seq !== intent.exact : !admitted) return null;
  return { origin: intent.origin, consent: intent.consent };
}
