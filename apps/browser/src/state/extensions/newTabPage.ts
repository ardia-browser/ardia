import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { newTabOpensOf } from "../settings/settings";
import type { InstalledExtension } from "../../platform/extensions";

type NewTabCandidate = Pick<InstalledExtension, "id" | "enabled" | "newTabPage" | "newTabRank">;
type Lists = Readonly<Record<string, readonly NewTabCandidate[]>>;
type ChoiceState = Pick<BrowserState, "settings" | "windows" | "profiles">;

export type NewTabChoice = { url: string | undefined; via: "address" | "override" | null; waits: boolean };

let listsByProfile: Lists = {};
const waiters: { profile: string; at: number; done: () => void }[] = [];

export const LIST_WAIT_MS = 3000;
const MAX_WAITERS = 32;
const EXTENSION_ID = /^[a-p]{32}$/;
const EXTENSION_ADDRESS = /^chrome-extension:\/\/([a-p]{32})(?:[/?#]|$)/;
const MAX_PAGE_PATH = 1024;
const UNSAFE_PATH_CHARACTER = /[\\\s\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ud800-\udfff]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const NONE: NewTabChoice = { url: undefined, via: null, waits: false };

export function setExtensionNewTabLists(lists: Lists, now = Date.now()) {
  listsByProfile = lists;
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i]!;
    if (!lists[waiter.profile]) continue;
    waiters.splice(i, 1);
    if (now - waiter.at <= LIST_WAIT_MS) waiter.done();
  }
}

export function extensionNewTabPage(ext: NewTabCandidate): string | undefined {
  const path = ext.newTabPage;
  if (ext.enabled !== true || typeof ext.id !== "string" || !EXTENSION_ID.test(ext.id) || typeof path !== "string") return undefined;
  const relative = path.replace(/^\/+/, "");
  if (!relative || relative.length > MAX_PAGE_PATH || UNSAFE_PATH_CHARACTER.test(relative) || SCHEME.test(relative)) return undefined;
  const file = relative.split(/[?#]/, 1)[0]!;
  if (!file || file.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  return `chrome-extension://${ext.id}/${relative}`;
}

const rankOf = (ext: NewTabCandidate) => (typeof ext.newTabRank === "number" && Number.isFinite(ext.newTabRank) ? ext.newTabRank : -1);

export function chromeNewTabOverride(list: readonly NewTabCandidate[]): string | undefined {
  let best: { url: string; rank: number } | undefined;
  for (const ext of list) {
    const url = extensionNewTabPage(ext);
    if (url && (!best || rankOf(ext) < best.rank)) best = { url, rank: rankOf(ext) };
  }
  return best?.url;
}

function profileOf(s: ChoiceState, windowId: string, profileId?: string | null): { profile: string; privately: boolean } | null {
  const w = s.windows[windowId];
  const own = profileId ?? w?.profileId;
  if (!own) return null;
  return { profile: engineProfile(s, own), privately: w?.kind === "private" || isIncognitoProfile(own) };
}

export function newTabChoice(s: ChoiceState, windowId: string, profileId: string | null | undefined, custom: string | undefined): NewTabChoice {
  const extensionId = custom?.match(EXTENSION_ADDRESS)?.[1];
  if (custom && !extensionId) return { url: custom, via: null, waits: false };
  if (!custom && newTabOpensOf(s.settings) !== "page") return NONE;
  const where = profileOf(s, windowId, profileId);
  if (!where || where.privately) return NONE;
  const list = listsByProfile[where.profile];
  if (!list) return { url: undefined, via: null, waits: true };
  if (extensionId) return list.some((ext) => ext.id === extensionId && ext.enabled === true) ? { url: custom, via: "address", waits: false } : NONE;
  const url = chromeNewTabOverride(list);
  return url ? { url, via: "override", waits: false } : NONE;
}

export function whenExtensionListKnown(s: ChoiceState, windowId: string, profileId: string | null | undefined, done: () => void, now = Date.now()) {
  const where = profileOf(s, windowId, profileId);
  if (!where || where.privately) return;
  if (listsByProfile[where.profile]) return done();
  waiters.push({ profile: where.profile, at: now, done });
  if (waiters.length > MAX_WAITERS) waiters.shift();
}
