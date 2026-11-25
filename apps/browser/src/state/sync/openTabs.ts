import { assignPositions, canonical, dropBase, putBase, recordsWith, type Adapter, type Extraction, type HLC, type ScopeState } from "../../platform/sync";
import { useBrowser, type BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { fromSync } from "../pins/pinOrderChoices";
import { noteOpenTabsPublished, noteOpenTabsWoke } from "../telemetry/openTabSyncCounts";
import { holdsOpenTabs, localOpenTabs, regularChain } from "./openTabsLocal";
import { OPEN_GROUP, OPEN_TAB, OPEN_TABS, OPEN_TABS_ON, openGroupValue, openTabValue, openTabsOn, type OpenGroupValue, type OpenTabValue } from "./openTabRecords";
import { applyOpenTabs } from "./openTabsApply";
import type { PinPageWrites } from "./pinnedApply";

export type OpenTabsMode = "on" | "off" | "retire";
export type OpenTabCloses = { keys: () => readonly string[]; settle: (keys: string[]) => void };

const store = () => useBrowser.getState();
const pagesSeen = new WeakMap<ScopeState, Map<string, string>>();
const pinPagesFromSync = new WeakMap<Map<string, string>, Map<string, Set<string>>>();

const MINUTE = 60_000;
const toMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const MAX_GROUP_DEPTH = 32;

function pagesSeenIn(state: ScopeState) {
  let seen = pagesSeen.get(state);
  if (!seen) pagesSeen.set(state, (seen = new Map()));
  return seen;
}

function pinPagesFromSyncIn(seen: Map<string, string>) {
  let pages = pinPagesFromSync.get(seen);
  if (!pages) pinPagesFromSync.set(seen, (pages = new Map()));
  return pages;
}

function keysInUse(s: BrowserState) {
  const keys = new Set([...Object.keys(s.tabs), ...Object.values(s.tabs).map(pinKeyOf)]);
  for (const parked of Object.values(s.parkedPins)) for (const p of parked.tabs) keys.add(p.id);
  return keys;
}

function forgetClosedPages(state: ScopeState, baseTab: (key: string) => OpenTabValue | null) {
  const seen = pagesSeenIn(state);
  let inUse: Set<string> | null = null;
  const gone = (key: string) => !baseTab(key) || openTabValue(state.records[`${OPEN_TAB}${key}`]?.v) === null;
  const fromSync = pinPagesFromSyncIn(seen);
  for (const key of seen.keys()) {
    if (!gone(key) || (inUse ??= keysInUse(store())).has(key)) continue;
    seen.delete(key);
    fromSync.delete(key);
  }
}

function forgetPinPagesNoCopyShows(s: BrowserState, profileId: string, fromSync: Map<string, Set<string>>) {
  if (!fromSync.size) return;
  const shown = new Map<string, Set<string>>();
  const show = (key: string, url: string) => {
    if (!fromSync.has(key)) return;
    const urls = shown.get(key);
    if (urls) urls.add(url);
    else shown.set(key, new Set([url]));
  };
  for (const t of Object.values(s.tabs)) if (t.profileId === profileId) show(pinKeyOf(t), t.url);
  for (const p of s.parkedPins[profileId]?.tabs ?? []) show(p.id, p.url);
  for (const [key, pages] of fromSync) {
    const urls = shown.get(key);
    for (const url of pages) if (!urls?.has(url)) pages.delete(url);
    if (!pages.size) fromSync.delete(key);
  }
}

const baseIn = (state: ScopeState) => (key: string) => {
  const json = state.base[`${OPEN_TAB}${key}`];
  return json === undefined ? null : openTabValue(JSON.parse(json));
};

function extractOpenTabs(profileId: string, state: ScopeState, closes: OpenTabCloses, base: (key: string) => unknown, remote: (key: string) => unknown): Extraction {
  const s = store();
  const { synced, pinned } = localOpenTabs(s, profileId);
  const closed = new Set(closes.keys());
  const seen = pagesSeenIn(state);
  const baseTabs = new Map<string, OpenTabValue | null>();
  const baseTab = (key: string) => {
    let tab = baseTabs.get(key);
    if (tab === undefined) baseTabs.set(key, (tab = openTabValue(base(`${OPEN_TAB}${key}`))));
    return tab;
  };
  forgetClosedPages(state, baseTab);
  const fromSync = pinPagesFromSyncIn(seen);
  forgetPinPagesNoCopyShows(s, profileId, fromSync);
  const positions = new Map<string, string>();
  for (const w of new Set(synced.map(({ tab }) => tab.windowId))) {
    const here = synced.filter(({ tab }) => tab.windowId === w);
    assignPositions(here.map(({ key }) => baseTab(key)?.pos)).forEach((pos, i) => positions.set(here[i]!.key, pos));
  }
  const values = new Map<string, unknown>([[OPEN_TABS_ON, { on: true }]]);
  synced.forEach(({ key, tab }) => {
    const was = baseTab(key);
    const before = seen.get(key);
    const navigatedHere = before !== undefined && before !== tab.url && !fromSync.get(key)?.has(tab.url);
    seen.set(key, tab.url);
    fromSync.delete(key);
    const u = !was || navigatedHere ? tab.url : was.u;
    const chain = regularChain(s.groups, tab.id);
    chain.forEach((g, j) =>
      values.set(`${OPEN_GROUP}${pinKeyOf(g)}`, { n: g.name, i: g.icon, c: g.color, p: j ? pinKeyOf(chain[j - 1]!) : null } satisfies OpenGroupValue),
    );
    values.set(`${OPEN_TAB}${key}`, {
      u,
      t: u === tab.url || !was ? tab.title : was.t,
      pos: positions.get(key)!,
      g: chain.length ? pinKeyOf(chain.at(-1)!) : null,
      a: Math.max(toMinute(tab.lastActiveAt), was?.a ?? 0),
    } satisfies OpenTabValue);
  });
  const referenced = new Set<string>();
  const reference = (group: string | null) => {
    for (let at = group, n = 0; at && n < MAX_GROUP_DEPTH && !referenced.has(at); n++) {
      referenced.add(at);
      at = openGroupValue(values.get(`${OPEN_GROUP}${at}`) ?? remote(`${OPEN_GROUP}${at}`))?.p ?? null;
    }
  };
  for (const [k, v] of values) if (k.startsWith(OPEN_TAB)) reference((v as OpenTabValue).g);
  for (const [k, record] of recordsWith(state, OPEN_TAB)) {
    if (record.v === null || values.has(k)) continue;
    const key = k.slice(OPEN_TAB.length);
    if (!closed.has(key) && !pinned.has(key)) reference(openTabValue(record.v)?.g ?? null);
  }
  const deletes = (k: string) => {
    if (k.startsWith(OPEN_TAB)) {
      const key = k.slice(OPEN_TAB.length);
      return closed.has(key) || pinned.has(key);
    }
    return k.startsWith(OPEN_GROUP) && !referenced.has(k.slice(OPEN_GROUP.length));
  };
  return {
    values,
    ignore: (k) => !deletes(k),
    published: (keys) => {
      const tabs = [...keys].filter((k) => k.startsWith(OPEN_TAB)).map((k) => k.slice(OPEN_TAB.length));
      noteOpenTabsPublished(tabs.length);
      closes.settle(tabs.filter((key) => closed.has(key)));
    },
  };
}

function closesOnly(profileId: string, state: ScopeState, closes: OpenTabCloses, base: (key: string) => unknown): Extraction | null {
  forgetClosedPages(state, (key) => openTabValue(base(`${OPEN_TAB}${key}`)));
  forgetPinPagesNoCopyShows(store(), profileId, pinPagesFromSyncIn(pagesSeenIn(state)));
  const closed = new Set(closes.keys());
  if (!closed.size) return null;
  const isClosed = (k: string) => k.startsWith(OPEN_TAB) && closed.has(k.slice(OPEN_TAB.length));
  return { values: new Map(), ignore: (k) => !isClosed(k), published: (keys) => closes.settle([...keys].filter(isClosed).map((k) => k.slice(OPEN_TAB.length))) };
}

function forget(state: ScopeState) {
  pagesSeen.delete(state);
  for (const k of Object.keys(state.base)) if (k.startsWith(OPEN_TABS)) dropBase(state, k);
  if (state.unapplied.some((k) => k.startsWith(OPEN_TABS))) state.unapplied = state.unapplied.filter((k) => !k.startsWith(OPEN_TABS));
}

function orphans(profileId: string, state: ScopeState, closed: Set<string>): { key: string; value: OpenTabValue }[] {
  const { held } = localOpenTabs(store(), profileId);
  return recordsWith(state, OPEN_TAB).flatMap(([k, record]) => {
    const key = k.slice(OPEN_TAB.length);
    const value = openTabValue(record.v);
    return value && !held.has(key) && !closed.has(key) ? [{ key, value }] : [];
  });
}

function adoptMatchingTabs(profileId: string, state: ScopeState, missing: { key: string; value: OpenTabValue }[]) {
  const s = store();
  const { synced } = localOpenTabs(s, profileId);
  const waiting = new Map<string, string[]>();
  for (const { key, value } of missing) {
    const same = waiting.get(value.u);
    if (same) same.push(key);
    else waiting.set(value.u, [key]);
  }
  const renamed = new Map<string, string>();
  for (const { key, tab } of synced) {
    if (`${OPEN_TAB}${key}` in state.base || `${OPEN_TAB}${key}` in state.records) continue;
    const match = waiting.get(tab.url)?.shift();
    if (match) renamed.set(key, match);
  }
  if (!renamed.size) return;
  const tabs = { ...s.tabs };
  for (const t of Object.values(s.tabs)) {
    const to = t.profileId === profileId ? renamed.get(pinKeyOf(t)) : undefined;
    if (!to) continue;
    const { pinKey: _, ...rest } = t;
    tabs[t.id] = to === t.id ? rest : { ...rest, pinKey: to };
  }
  fromSync(() => useBrowser.setState({ tabs }));
}

function bringBackMissing(profileId: string, state: ScopeState, closed: Set<string>) {
  const missing = orphans(profileId, state, closed);
  if (!missing.length) return;
  adoptMatchingTabs(profileId, state, missing);
  const keys = orphans(profileId, state, closed).map(({ key }) => `${OPEN_TAB}${key}`);
  if (keys.length) state.unapplied = [...new Set([...state.unapplied, ...keys])];
  noteOpenTabsWoke();
}

const switchedLater = (state: ScopeState, on: boolean, flag: HLC | undefined) => {
  const marker = state.records[OPEN_TABS_ON];
  return !!marker && openTabsOn(marker.v) === on && (flag === undefined || marker.h > flag);
};

function settleCloses(profileId: string, state: ScopeState, closes: OpenTabCloses) {
  const { held } = localOpenTabs(store(), profileId);
  const done: string[] = [];
  for (const key of closes.keys()) {
    const k = `${OPEN_TAB}${key}`;
    const record = state.records[k];
    if (held.has(key)) done.push(key);
    else if (record && record.v !== null && !(k in state.base)) putBase(state, k, canonical(record.v));
    else if (!(k in state.base)) done.push(key);
  }
  if (done.length) closes.settle(done);
}

function retire(state: ScopeState): Adapter {
  pagesSeen.delete(state);
  for (const [k, record] of recordsWith(state, OPEN_TABS)) if (record.v !== null) putBase(state, k, canonical(record.v));
  return { prefix: OPEN_TABS, extract: () => ({ values: new Map([[OPEN_TABS_ON, { on: false }]]) }), apply: () => true };
}

const waiting: Adapter = { prefix: OPEN_TABS, extract: () => null, apply: () => false };

export function openTabsAdapters(profileId: string, state: ScopeState, mode: OpenTabsMode, closes: OpenTabCloses, flag: () => HLC | undefined): Adapter[] {
  if (mode !== "on" && closes.keys().length) closes.settle([...closes.keys()]);
  if (mode === "off") {
    forget(state);
    return [];
  }
  if (mode === "retire") return [switchedLater(state, true, flag()) ? waiting : retire(state)];
  if (switchedLater(state, false, flag())) return [waiting];
  settleCloses(profileId, state, closes);
  const off = () => switchedLater(state, false, flag());
  if (!holdsOpenTabs(store(), profileId)) return [{ prefix: OPEN_TABS, extract: (base) => (off() ? null : closesOnly(profileId, state, closes, base)), apply: () => false }];
  bringBackMissing(profileId, state, new Set(closes.keys()));
  return [
    {
      prefix: OPEN_TABS,
      extract: (base, _queued, _now, _known, remote) => (off() ? null : extractOpenTabs(profileId, state, closes, base, remote)),
      apply: (visible, changed) => !off() && applyOpenTabs(profileId, visible, changed, new Set(closes.keys()), pagesSeenIn(state)),
    },
  ];
}

export function openTabsPinPageWrites(profileId: string, state: ScopeState, mode: OpenTabsMode, flag: () => HLC | undefined): PinPageWrites | undefined {
  if (mode !== "on") return undefined;
  return (written) => {
    const seen = pagesSeenIn(state);
    const fromSync = pinPagesFromSyncIn(seen);
    if (!switchedLater(state, false, flag())) {
      for (const [key, urls] of written) {
        for (const url of urls) {
          const baseline = seen.get(key);
          if (baseline === undefined) seen.set(key, url);
          else if (baseline !== url) {
            const pages = fromSync.get(key);
            if (pages) pages.add(url);
            else fromSync.set(key, new Set([url]));
          }
        }
      }
    }
    forgetClosedPages(state, baseIn(state));
    forgetPinPagesNoCopyShows(store(), profileId, fromSync);
  };
}
