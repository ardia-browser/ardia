import type { BrowserState } from "../browser/store";
import type { BrowserWindow, Tab } from "../browser/types";
import { inPinnedContainer, isPinnedRow } from "../browser/model";
import { changedIds, linkEdits } from "../browser/changes";
import { groupIndex, pinnedGroupMembers, splitIndex } from "../browser/structure";
import { isFields, isString, isStringList } from "../../lib/decode";
import type { SavedObject } from "../../lib/savedDocument";
import { sameList } from "../../lib/lists";
import { notePinChildrenPlaced } from "../telemetry/pinChildCounts";
import type { ConsentToken } from "../telemetry/consentPeriod";

type Nesting = Pick<BrowserState, "tabs" | "groups" | "splits">;
type Indexed = Nesting & Pick<BrowserState, "windows">;
export type PinChildIndex = ReadonlyMap<string, readonly string[]>;

const NONE: readonly string[] = [];
const NO_CHILDREN: PinChildIndex = new Map();

export const opensNested = (s: Pick<BrowserState, "tabs" | "groups">, openerId: string): boolean =>
  isPinnedRow(s.tabs[openerId]) || (!!s.tabs[openerId] && pinnedGroupMembers(s.groups).has(openerId));

export function nestsUnder(s: Pick<BrowserState, "tabs" | "groups">, child: Pick<Tab, "windowId" | "profileId">, openerId: string | null | undefined): boolean {
  const opener = openerId ? s.tabs[openerId] : undefined;
  return !!opener && opener.windowId === child.windowId && opener.profileId === child.profileId && opensNested(s, opener.id);
}

export function nestedOpener(s: Nesting, id: string): string | undefined {
  const child = s.tabs[id];
  const openerId = child?.pinChildOf;
  if (!openerId || child.pin || groupIndex(s.groups).has(id) || splitIndex(s.splits).has(id)) return undefined;
  return nestsUnder(s, child, openerId) ? openerId : undefined;
}

const nestsAlike = (a: Tab | undefined, b: Tab | undefined) => a === b || (!!a && !!b && a.pinChildOf === b.pinChildOf && a.pin === b.pin && a.profileId === b.profileId);

function sameNesting(tabs: BrowserState["tabs"], was: BrowserState["tabs"]): boolean {
  if (tabs === was) return true;
  for (const id of changedIds(tabs, was)) if (!nestsAlike(tabs[id], was[id])) return false;
  return true;
}

let indexed: (Indexed & { index: PinChildIndex; marked: boolean }) | null = null;

export function pinChildIndex(s: Indexed): PinChildIndex {
  const was = indexed;
  if (was && was.groups === s.groups && was.splits === s.splits && (was.windows === s.windows || !was.marked) && sameNesting(s.tabs, was.tabs)) {
    was.tabs = s.tabs;
    was.windows = s.windows;
    return was.index;
  }
  const marked = Object.values(s.tabs).some((t) => !!t.pinChildOf);
  const next = new Map<string, string[]>();
  for (const w of marked ? Object.values(s.windows) : []) {
    for (const id of w.tabIds) {
      const opener = s.tabs[id]?.pinChildOf ? nestedOpener(s, id) : undefined;
      if (!opener) continue;
      const kids = next.get(opener);
      if (kids) kids.push(id);
      else next.set(opener, [id]);
    }
  }
  const index = steady(was?.index, next);
  indexed = { tabs: s.tabs, windows: s.windows, groups: s.groups, splits: s.splits, index, marked };
  return index;
}

function steady(was: PinChildIndex | undefined, next: Map<string, readonly string[]>): PinChildIndex {
  if (!next.size) return NO_CHILDREN;
  if (!was?.size) return next;
  let same = was.size === next.size;
  for (const [opener, kids] of next) {
    const old = was.get(opener);
    if (old && sameList(old, kids)) next.set(opener, old);
    else same = false;
  }
  return same ? was : next;
}

export const pinChildrenOf = (s: Indexed, openerId: string): readonly string[] => pinChildIndex(s).get(openerId) ?? NONE;

const tabsOnTop = (s: Partial<Pick<BrowserState, "windows" | "settings">>, windowId: string) => (s.windows?.[windowId]?.tabLayout || s.settings?.tabLayout) === "top";

export const shownPinChildren = (s: BrowserState, windowId: string): PinChildIndex => (tabsOnTop(s, windowId) ? NO_CHILDREN : pinChildIndex(s));

export function inShownOrder(s: BrowserState, windowId: string, ids: string[]): string[] {
  const index = shownPinChildren(s, windowId);
  if (!index.size) return ids;
  const present = new Set(ids);
  const nested = new Set<string>();
  for (const [opener, kids] of index) if (present.has(opener)) for (const kid of kids) nested.add(kid);
  if (!nested.size) return ids;
  const out: string[] = [];
  for (const id of ids) {
    if (nested.has(id)) continue;
    out.push(id);
    for (const kid of index.get(id) ?? NONE) if (present.has(kid)) out.push(kid);
  }
  return out;
}

export function pinChildInsertion(s: Indexed, w: BrowserWindow, openerId: string, first: number): number {
  const kids = pinChildrenOf(s, openerId);
  for (let i = kids.length - 1; i >= 0; i--) {
    const at = w.tabIds.indexOf(kids[i]!);
    if (at >= 0) return at + 1;
  }
  return first;
}

export function steppedPinChild(s: BrowserState, id: string, delta: 1 | -1): BrowserState | null {
  const opener = nestedOpener(s, id);
  if (!opener) return null;
  const kids = pinChildrenOf(s, opener);
  const other = kids[kids.indexOf(id) + delta];
  const w = s.windows[s.tabs[id]!.windowId];
  if (!other || !w) return s;
  const tabIds = w.tabIds.map((t) => (t === id ? other : t === other ? id : t));
  return { ...s, windows: { ...s.windows, [w.id]: { ...w, tabIds } } };
}

export function settledPinChildren(before: BrowserState, after: BrowserState, moved: readonly string[], consent?: ConsentToken | null): BrowserState {
  let tabs = after.tabs;
  const edited: string[] = [];
  const unmark = (id: string) => {
    if (tabs === after.tabs) tabs = { ...after.tabs };
    const { pinChildOf: _, ...tab } = tabs[id]!;
    tabs[id] = tab;
    edited.push(id);
  };
  let pinned = 0;
  let out = 0;
  for (const id of moved) {
    if (tabs[id]?.pinChildOf) {
      if (nestedOpener(before, id)) {
        if (inPinnedContainer(after, id)) pinned++;
        else out++;
      }
      unmark(id);
    }
    if (!opensNested(before, id) || opensNested(after, id)) continue;
    for (const kid of pinChildrenOf(before, id)) if (tabs[kid]?.pinChildOf === id) unmark(kid);
  }
  if (!edited.length) return after;
  if (pinned || out) notePinChildrenPlaced(pinned, out, consent);
  return { ...after, tabs: linkEdits(tabs, after.tabs, edited) };
}

const LEGACY_OPENER = "pinnedOpenerId";

const withoutLegacyOpener = (g: unknown): unknown => {
  if (!isFields(g) || !(LEGACY_OPENER in g)) return g;
  const { [LEGACY_OPENER]: _, ...rest } = g;
  return rest;
};

export function sessionWithPinChildMarkers(doc: SavedObject): SavedObject {
  const rows = Array.isArray(doc.groups) ? doc.groups : [];
  const parents = new Set(rows.filter(isFields).map((g) => g.parentId));
  const openerOf = new Map<string, string>();
  const groups: unknown[] = [];
  for (const g of rows) {
    const opener = isFields(g) ? g[LEGACY_OPENER] : undefined;
    const gathered = isFields(g) && isString(opener) && g.pinned !== true && !g.parentId && !parents.has(g.id) && isStringList(g.tabIds);
    if (gathered) for (const id of g.tabIds as string[]) openerOf.set(id, opener);
    else groups.push(withoutLegacyOpener(g));
  }
  const marked = (t: unknown): unknown => (isFields(t) && isString(t.id) && openerOf.has(t.id) && !isString(t.pinChildOf) ? { ...t, pinChildOf: openerOf.get(t.id) } : t);
  const parked = (park: unknown): unknown => (isFields(park) && Array.isArray(park.groups) ? { ...park, groups: park.groups.map(withoutLegacyOpener) } : park);
  return {
    ...doc,
    ...(Array.isArray(doc.groups) ? { groups } : {}),
    ...(Array.isArray(doc.tabs) && openerOf.size ? { tabs: doc.tabs.map(marked) } : {}),
    ...(isFields(doc.parkedPins) ? { parkedPins: Object.fromEntries(Object.entries(doc.parkedPins).map(([p, park]) => [p, parked(park)])) } : {}),
  };
}
