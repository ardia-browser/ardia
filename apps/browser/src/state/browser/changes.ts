import { consentOrNow, countFor } from "../telemetry/countFor";

const NONE: readonly string[] = [];
const memo = new WeakMap<object, WeakMap<object, readonly string[]>>();
const keyLists = new WeakMap<object, readonly string[]>();

type Link = { readonly from: number; readonly ids: readonly string[] };
type KeyOrder = { readonly base: ReadonlyMap<string, number>; readonly appended: readonly string[]; readonly dropped: number };

export const LINKS_KEPT = 8;
const LINKED_IDS_MAX = 256;
const APPENDED_KEPT = 64;

const stamps = new WeakMap<object, number>();
const chains = new WeakMap<object, readonly Link[]>();
const keyOrders = new WeakMap<object, KeyOrder>();
let lastStamp = 0;
const ownKey = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const indexLike = /^(?:0|[1-9]\d*)$/;

export const changeDetection = { linked: 0, scanned: 0, scannedEntries: 0 };
const countLinked = () => void changeDetection.linked++;
let lastScanSize = 0;
const countScanned = () => {
  changeDetection.scanned++;
  changeDetection.scannedEntries += lastScanSize;
};

export function takeChangeDetectionCounts() {
  const taken = { record_changes_linked: changeDetection.linked, record_changes_scanned: changeDetection.scanned, record_changes_scanned_entries: changeDetection.scannedEntries };
  changeDetection.linked = 0;
  changeDetection.scanned = 0;
  changeDetection.scannedEntries = 0;
  return taken;
}

export function keysOf(o: object): readonly string[] {
  let keys = keyLists.get(o);
  if (!keys) keyLists.set(o, (keys = Object.keys(o)));
  return keys;
}

function stampOf(o: object): number {
  let stamp = stamps.get(o);
  if (stamp === undefined) stamps.set(o, (stamp = ++lastStamp));
  return stamp;
}

function freshKeyOrder(record: object): KeyOrder {
  const keys = keysOf(record);
  const base = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) base.set(keys[i]!, i);
  return { base, appended: NONE, dropped: 0 };
}

function keyOrderOf(record: object): KeyOrder {
  let order = keyOrders.get(record);
  if (!order) keyOrders.set(record, (order = freshKeyOrder(record)));
  return order;
}

function derivedKeyOrder(order: KeyOrder, next: object, prev: object, ids: readonly string[]): KeyOrder | null {
  let appended = order.appended;
  let dropped = order.dropped;
  let newcomer: string | null = null;
  for (const id of ids) {
    const was = ownKey(prev, id);
    if (was === ownKey(next, id)) continue;
    if (was) {
      if (appended.includes(id)) appended = appended.filter((key) => key !== id);
      else if (++dropped * 2 > order.base.size) return null;
      continue;
    }
    if (newcomer !== null && newcomer !== id) return null;
    if (indexLike.test(id)) return null;
    newcomer = id;
  }
  if (newcomer !== null) appended = [...appended, newcomer];
  if (appended.length > APPENDED_KEPT) return null;
  return appended === order.appended && dropped === order.dropped ? order : { base: order.base, appended, dropped };
}

const rankIn = (order: KeyOrder, id: string): number | undefined => {
  const at = order.appended.indexOf(id);
  return at < 0 ? order.base.get(id) : order.base.size + at;
};

function inKeyOrder(record: object, ids: string[]): string[] {
  if (ids.length < 2) return ids;
  let order = keyOrderOf(record);
  if (ids.some((id) => rankIn(order, id) === undefined)) keyOrders.set(record, (order = freshKeyOrder(record)));
  return ids.sort((a, b) => rankIn(order, a)! - rankIn(order, b)!);
}

export const keyOrderBase = (record: object): ReadonlyMap<string, number> | undefined => keyOrders.get(record)?.base;

export const linkChanges = <R extends object>(next: R, prev: R, ids: readonly string[]): R => link(next, prev, ids, false);

export const linkEdits = <R extends object>(next: R, prev: R, ids: readonly string[]): R => link(next, prev, ids, true);

function link<R extends object>(next: R, prev: R, ids: readonly string[], keyOrderKept: boolean): R {
  if (next === prev || chains.has(next)) return next;
  const order = keyOrderKept ? keyOrders.get(prev) : undefined;
  const derived = order && derivedKeyOrder(order, next, prev, ids);
  if (derived) keyOrders.set(next, derived);
  if (ids.length > LINKED_IDS_MAX) return next;
  const chain: Link[] = [{ from: stampOf(prev), ids }];
  let total = ids.length;
  for (const link of chains.get(prev) ?? NONE_LINKS) {
    total += link.ids.length;
    if (chain.length >= LINKS_KEPT || total > LINKED_IDS_MAX) break;
    chain.push(link);
  }
  chains.set(next, chain);
  return next;
}

const NONE_LINKS: readonly Link[] = [];

export function withEntry<T>(record: Record<string, T>, id: string, value: T): Record<string, T> {
  return linkEdits({ ...record, [id]: value }, record, [id]);
}

export function withoutEntries<T>(record: Record<string, T>, ids: Iterable<string>): Record<string, T> {
  const next = { ...record };
  const gone = [...new Set(ids)];
  for (const id of gone) delete next[id];
  return linkEdits(next, record, gone);
}

export function linkedChangedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] | null {
  if (next === prev) return NONE;
  const hit = memo.get(next)?.get(prev);
  if (hit) return hit;
  const chain = chains.get(next);
  const from = chain && stamps.get(prev);
  if (!chain || from === undefined) return null;
  let reach = -1;
  let total = 0;
  for (let i = 0; i < chain.length; i++) {
    total += chain[i]!.ids.length;
    if (total > LINKED_IDS_MAX) return null;
    if (chain[i]!.from === from) {
      reach = i;
      break;
    }
  }
  if (reach < 0) return null;
  const kept: string[] = [];
  const gone: string[] = [];
  const seen = reach || chain[0]!.ids.length > 1 ? new Set<string>() : null;
  for (let i = reach; i >= 0; i--) {
    for (const id of chain[i]!.ids) {
      if (seen) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (next[id] === prev[id]) continue;
      if (ownKey(next, id)) kept.push(id);
      else gone.push(id);
    }
  }
  const ids = inKeyOrder(next, kept);
  if (gone.length) ids.push(...inKeyOrder(prev, gone));
  countFor(consentOrNow(undefined), countLinked);
  return remember(next, prev, ids);
}

export function scannedChangedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  const ids: string[] = [];
  const keys = keysOf(next);
  let added = 0;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i]!;
    const before = prev[id];
    if (next[id] === before) continue;
    ids.push(id);
    if (before === undefined) added++;
  }
  const before = keysOf(prev);
  const removals = before.length > keys.length - added;
  if (removals) for (const id of before) if (next[id] === undefined) ids.push(id);
  lastScanSize = keys.length + (removals ? before.length : 0);
  return ids;
}

function remember(next: object, prev: object, ids: readonly string[]): readonly string[] {
  let byPrev = memo.get(next);
  if (!byPrev) memo.set(next, (byPrev = new WeakMap()));
  byPrev.set(prev, ids);
  return ids;
}

export function changedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  const linked = linkedChangedIds(next, prev);
  if (linked) return linked;
  const ids = scannedChangedIds(next, prev);
  countFor(consentOrNow(undefined), countScanned);
  return remember(next, prev, ids);
}
