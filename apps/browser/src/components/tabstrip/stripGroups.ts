import type { StripDock, StripEntry, StripGroupEntry, StripMember } from "../../state/tabs/topStrip";
import type { Dock } from "./model";
import { CLOSE_MIN_CHIP, COMPACT_CHIP, DOCK_GAP, GAP, MAX_CHIP, NEW_TAB_ROOM, PEEK_BORDER, PEEK_LEFT, PINNED_CELL, PINNED_SPACING, SELECTED_MIN_CHIP, SELECTED_STEPS, TITLE_MIN_CHIP, TITLED_CHIP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT } from "./tokens";
import { captionRoom, WINDOW_CHROME, type WindowChrome } from "../../lib/windowChrome";

export const GROUP_MARGIN_LEFT = 3.5;
export const GROUP_MARGIN_RIGHT = 4;
export const MEMBERS_INSET = 6.5;
export const TAIL_COLLAPSED = 4.5;
export const TAIL_EXPANDED = 30.25;

type GroupLayout = { offsets: number[]; width: number };

export function groupLayout(chip: number, widths: number[], gap: number, expanded: boolean, shown: number): GroupLayout {
  const offsets: number[] = [];
  let x = 0;
  for (const w of widths) {
    offsets.push(x);
    x += w + gap;
  }
  const members = widths.length ? x - gap : 0;
  if (expanded && widths.length) return { offsets, width: chip + MEMBERS_INSET + members + TAIL_EXPANDED };
  if (shown >= 0 && widths[shown] !== undefined) return { offsets, width: chip + MEMBERS_INSET + widths[shown]! + TAIL_COLLAPSED };
  return { offsets, width: chip };
}

export type TabWidths = { chip: number; titled: number; selected: number };

const halfPoint = (w: number) => Math.round(w * 2) / 2;

export function stripTabWidths(o: {
  pageWidth: number;
  dockWidth: number;
  groups: { chip: number; expanded: boolean; shown: boolean }[];
  compactUnits: number;
  titledUnits: number;
  selectedShown: boolean;
  fixed: number;
  gap: number;
  plus: number;
  min: number;
  titledMin: number;
  selectedMin: number;
  max: number;
  shrinkTabs?: boolean;
}): TabWidths {
  let room = o.pageWidth - o.dockWidth - o.plus - o.gap - o.fixed;
  for (const g of o.groups) {
    const parts = g.expanded ? MEMBERS_INSET + TAIL_EXPANDED : g.shown ? MEMBERS_INSET + TAIL_COLLAPSED : 0;
    room -= GROUP_MARGIN_LEFT + GROUP_MARGIN_RIGHT + g.chip + parts + o.gap;
  }
  const units = o.compactUnits + o.titledUnits + (o.selectedShown ? 1 : 0);
  if (!units) return { chip: o.max, titled: o.max, selected: o.max };
  const at = (level: number, min: number) => Math.max(min, Math.min(o.max, level));
  const selectedMin = Math.min(o.max, o.selectedMin);
  const used = (level: number) =>
    o.compactUnits * at(level, o.min) + o.titledUnits * at(level, o.titledMin) + (o.selectedShown ? at(level, selectedMin) : 0) + units * o.gap;
  let level = o.max;
  if (used(level) > room) {
    let lo = 0;
    let hi = o.max;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (used(mid) > room) hi = mid;
      else lo = mid;
    }
    level = lo + 1e-6;
    if (o.shrinkTabs) level = Math.floor(level * 2) / 2;
  }
  return { chip: halfPoint(at(level, o.min)), titled: halfPoint(at(level, o.titledMin)), selected: halfPoint(at(level, o.selectedShown ? selectedMin : o.min)) };
}

type DragSlot = { tabIds: string[]; width: number; marginLeft?: number; marginRight?: number };
export type DragGeometry = { slots: DragSlot[]; lefts: number[] };

export function dragGeometry(slots: DragSlot[], gap: number): DragGeometry {
  const lefts: number[] = [];
  let x = 0;
  for (const slot of slots) {
    x += slot.marginLeft ?? 0;
    lefts.push(x);
    x += slot.width + (slot.marginRight ?? 0) + gap;
  }
  return { slots, lefts };
}

export function dragRange({ slots, lefts }: DragGeometry, from: number): [number, number] {
  const last = slots.length - 1;
  return [lefts[0]! - lefts[from]!, lefts[last]! + slots[last]!.width - (lefts[from]! + slots[from]!.width)];
}

export function dropIndex({ slots, lefts }: DragGeometry, from: number, dx: number): number {
  const left = lefts[from]! + dx;
  const right = left + slots[from]!.width;
  let index = 0;
  slots.forEach((slot, i) => {
    const centre = lefts[i]! + slot.width / 2;
    if (i < from ? centre < left : i > from && centre < right) index++;
  });
  return index;
}

export function leaveIndex({ slots, lefts }: DragGeometry, slot: number, chip: number, expanded: boolean, left: number, width: number): number | null {
  const start = lefts[slot]!;
  const end = start + slots[slot]!.width;
  const right = left + width;
  const centre = (i: number) => lefts[i]! + slots[i]!.width / 2;
  if (left < start + chip / 2) {
    let at = slot;
    while (at > 0 && centre(at - 1) > left) at--;
    return at;
  }
  if (right > (expanded ? end - TAIL_EXPANDED / 2 : end + MEMBERS_INSET)) {
    let at = slot + 1;
    while (at < slots.length && centre(at) < right) at++;
    return at;
  }
  return null;
}

export function dockCellOf(cells: string[], members: (cell: string) => string[], tabId: string): number {
  const own = cells.indexOf(tabId);
  return own >= 0 ? own : cells.findIndex((cell) => members(cell).includes(tabId));
}

export function revealOffset(left: number, width: number, scrolled: number, viewport: number, pad: number): number | null {
  const toStart = left - pad;
  const toEnd = left + width + pad - viewport;
  const target = toStart < scrolled ? toStart : toEnd > scrolled ? Math.min(toStart, toEnd) : scrolled;
  const clamped = Math.max(0, target);
  return Math.abs(clamped - scrolled) < 0.5 ? null : clamped;
}

export function memberInteractive(shown: boolean, expanded: boolean, moving: boolean): boolean {
  return shown || (expanded && !moving);
}

export const holds = (m: StripMember, tabId: string) => (m.kind === "tab" ? m.id === tabId : m.tabIds.includes(tabId));
export const tabsOf = (m: StripMember) => (m.kind === "tab" ? [m.id] : m.tabIds);
export const CELL_STEP = PINNED_CELL + PINNED_SPACING;
export const dockWidth = (cells: number) => cells * CELL_STEP - PINNED_SPACING;

type StripMeasures = { groupChip: (groupId: string) => number | undefined; folderChip: (groupId: string) => number | undefined; needsTitle?: (tabId: string) => boolean; shrinkTabs?: boolean };
type StripLayout = {
  chip: number;
  selected: number;
  widths: TabWidths;
  tabWidth: (tabId: string) => number;
  top: DragGeometry;
  memberWidth: (m: StripMember) => number;
  spanOf: (tabId: string) => [number, number] | null;
  tabsEnd: number;
  tabsShrink: boolean;
  wideShown: boolean;
  compactShown: number;
  titledShown: number;
};

const dockEntry = (entries: StripEntry[]) => entries.find((e): e is StripDock => e.kind === "dock");
const dockTabs = (dock: StripDock, cell: string) => dock.members.get(cell) ?? [cell];
const dockSpan = (dock: StripDock | undefined) => (dock?.ids.length ? dockWidth(dock.ids.length) + DOCK_GAP : 0);

export function layoutDock(dock: StripDock | undefined): Dock | null {
  if (!dock?.ids.length) return null;
  return { ids: dock.ids, left: -dockSpan(dock), geometry: dragGeometry(dock.ids.map((id) => ({ tabIds: dockTabs(dock, id), width: PINNED_CELL })), PINNED_SPACING) };
}

export type Stretch = { tabId: string; by: number };
export function layoutStrip(entries: StripEntry[], activeId: string, pageWidth: number, measured: StripMeasures, dockLayout: Dock | null, held?: TabWidths, wideId: string = activeId, selectedMin: number = SELECTED_MIN_CHIP, titledMin: number = TITLED_CHIP, compactMin: number = COMPACT_CHIP, stretch: Stretch | null = null): StripLayout {
  const dock = dockEntry(entries);
  const rows = entries.filter((e): e is StripGroupEntry | StripMember => e.kind !== "dock");
  const groupChip = (g: StripGroupEntry) => measured.groupChip(g.id) ?? 0;
  const folderChip = (m: StripMember) => measured.folderChip(m.id) ?? 0;
  const visible = rows.flatMap((e) => (e.kind !== "group" ? [e] : e.collapsed ? e.members.filter((m) => holds(m, activeId)) : e.members));
  const needsTitle = measured.needsTitle ?? (() => false);
  const shownTabs = (m: StripMember) =>
    m.kind === "split" ? (m.tabIds.includes(wideId) ? [wideId, ...m.tabIds.filter((id) => id !== wideId)] : m.tabIds).slice(0, 2) : m.kind === "folder" ? (holds(m, activeId) ? [activeId] : []) : [m.id];
  const visibleTabs = visible.flatMap(shownTabs);
  const tabUnits = visibleTabs.length;
  const wideShown = visibleTabs.includes(wideId);
  const others = visibleTabs.filter((id) => id !== wideId);
  const compactShown = others.filter((id) => !needsTitle(id)).length;
  const titledShown = others.length - compactShown;
  const widths = held ?? stripTabWidths({
    pageWidth,
    dockWidth: dockSpan(dock),
    groups: rows.flatMap((e) => (e.kind === "group" ? [{ chip: groupChip(e), expanded: !e.collapsed && hasVisibleMembers(e), shown: e.members.some((m) => holds(m, activeId)) }] : [])),
    compactUnits: compactShown,
    titledUnits: titledShown,
    selectedShown: wideShown,
    fixed: visible.reduce((n, m) => n + (m.kind === "folder" ? folderChip(m) + (holds(m, activeId) ? MEMBERS_INSET : GAP) : 0), 0),
    gap: GAP,
    plus: NEW_TAB_ROOM,
    min: compactMin,
    titledMin,
    selectedMin,
    max: MAX_CHIP,
    shrinkTabs: measured.shrinkTabs,
  });
  const { chip, selected } = widths;
  const tabWidth = (tabId: string) => (tabId === wideId ? selected : needsTitle(tabId) ? widths.titled : chip) + (tabId === stretch?.tabId ? stretch.by : 0);
  const unitsWidth = (m: StripMember) => shownTabs(m).reduce((n, id) => n + tabWidth(id), 0);
  const memberWidth = (m: StripMember) => (m.kind === "folder" ? folderChip(m) + (holds(m, activeId) ? MEMBERS_INSET + tabWidth(activeId) : 0) : unitsWidth(m));
  const groups = new Map(
    rows.flatMap((e) => {
      if (e.kind !== "group") return [];
      const widths = e.members.map(memberWidth);
      return [[e, { widths, ...groupLayout(groupChip(e), widths, GAP, !e.collapsed, e.members.findIndex((m) => holds(m, activeId))) }] as const];
    }),
  );
  const top = dragGeometry(
    rows.map((e): DragSlot => {
      if (e.kind !== "group") return { tabIds: tabsOf(e), width: unitsWidth(e) };
      return { tabIds: e.memberTabIds ?? e.members.flatMap(tabsOf), width: groups.get(e)!.width, marginLeft: GROUP_MARGIN_LEFT, marginRight: GROUP_MARGIN_RIGHT };
    }),
    GAP,
  );
  const spanOf = (tabId: string): [number, number] | null => {
    const cell = dock && dockLayout ? dockCellOf(dock.ids, (id) => dockTabs(dock, id), tabId) : -1;
    if (cell >= 0) return [dockLayout!.geometry.lefts[cell]!, PINNED_CELL];
    const i = top.slots.findIndex((slot) => slot.tabIds.includes(tabId));
    if (i < 0) return null;
    const left = dockSpan(dock) + top.lefts[i]!;
    const row = rows[i]!;
    if (row.kind !== "group") return [left, top.slots[i]!.width];
    const at = row.members.findIndex((m) => holds(m, tabId));
    if (at < 0) return [left, top.slots[i]!.width];
    const { widths, offsets } = groups.get(row)!;
    if (row.collapsed) return [left, groupChip(row) + MEMBERS_INSET + widths[at]!];
    return [left + groupChip(row) + MEMBERS_INSET + offsets[at]!, widths[at]!];
  };
  const end = top.slots.length ? top.lefts.at(-1)! + top.slots.at(-1)!.width : 0;
  return { chip, selected, widths, tabWidth, top, memberWidth, spanOf, tabsEnd: dockSpan(dock) + end, tabsShrink: tabUnits > 0, wideShown, compactShown, titledShown };
}

export function nameGrowth(natural: number | undefined): number {
  if (natural === undefined) return GROUP_TITLE_MAX - GROUP_TITLE_TIGHT;
  return Math.max(0, Math.min(natural, GROUP_TITLE_MAX) - Math.min(natural, GROUP_TITLE_TIGHT));
}

export function withRoomyNames(measures: StripMeasures, nameWidth: (groupId: string) => number | undefined): StripMeasures {
  return { ...measures, groupChip: (groupId) => { const base = measures.groupChip(groupId); return base === undefined ? undefined : base + nameGrowth(nameWidth(groupId)); } };
}

export function namesStayTight(tight: boolean, fit: StripFit, roomy: () => StripFit): boolean {
  if (underPressure(fit)) return true;
  return tight && underPressure(roomy());
}

export const hasVisibleMembers = (entry: StripGroupEntry): boolean => entry.members.length > 0;

export function keyedWidths(ids: readonly string[], widths: readonly (number | undefined)[]): (id: string) => number | undefined {
  const at = new Map(ids.map((id, i) => [id, i]));
  return (id) => {
    const i = at.get(id);
    return i === undefined ? undefined : widths[i];
  };
}

export type StripFit = { selectedMin: number; titledMin: number; compactMin: number };

export function stripFit(entries: StripEntry[], activeId: string, pageWidth: number, measured: StripMeasures, dockLayout: Dock | null, wideId: string = activeId): StripFit {
  const limit = pageWidth + 0.5 - GAP - NEW_TAB_ROOM;
  const tight = SELECTED_STEPS.at(-1)!;
  const layout = (selectedMin: number, held?: TabWidths, titledMin: number = TITLED_CHIP, compactMin: number = COMPACT_CHIP) =>
    layoutStrip(entries, activeId, pageWidth, measured, dockLayout, held, wideId, selectedMin, titledMin, compactMin);
  const fits = (selectedMin: number) => layout(selectedMin).tabsEnd <= limit;
  const least = layout(tight, { chip: COMPACT_CHIP, titled: TITLED_CHIP, selected: tight });
  const tightEnd = least.tabsEnd;
  const step = (end: number, selected: number) => end + (least.wideShown ? selected - tight : 0);
  const readableEnd = tightEnd + least.compactShown * (TITLE_MIN_CHIP - COMPACT_CHIP);
  const evenEnd = readableEnd - least.titledShown * (TITLED_CHIP - TITLE_MIN_CHIP);
  const readable = (selectedMin: number, titledMin: number) => layout(selectedMin, undefined, titledMin, TITLE_MIN_CHIP).tabsEnd <= limit;
  const even = () => evenEnd <= limit && readable(tight, TITLE_MIN_CHIP);
  if (least.compactShown) {
    const readableStep = SELECTED_STEPS.find((selected) => step(readableEnd, selected) <= limit && readable(selected, TITLED_CHIP));
    if (readableStep !== undefined) return { selectedMin: readableStep, titledMin: TITLED_CHIP, compactMin: TITLE_MIN_CHIP };
    if (even()) return { selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  }
  const roomy = SELECTED_STEPS.find((selected) => step(tightEnd, selected) <= limit && fits(selected));
  if (roomy !== undefined) return { selectedMin: roomy, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
  if (!least.compactShown && even()) return { selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  if (measured.shrinkTabs) return { selectedMin: CLOSE_MIN_CHIP, titledMin: COMPACT_CHIP, compactMin: COMPACT_CHIP };
  return { selectedMin: tight, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
}

export function underPressure({ selectedMin, titledMin }: StripFit): boolean {
  return selectedMin < SELECTED_MIN_CHIP || titledMin < TITLED_CHIP;
}

export function heldWideTab(entries: StripEntry[], wide: { tabId: string; slot: number }): { tabId: string; atEnd: boolean } {
  const rows = entries.filter((e): e is StripGroupEntry | StripMember => e.kind !== "dock");
  const atEnd = wide.slot >= rows.length;
  const row = rows[Math.min(wide.slot, rows.length - 1)];
  if (!row || row.kind === "group") return { tabId: wide.tabId, atEnd: false };
  return { tabId: tabsOf(row)[0]!, atEnd };
}

export function stripCaptionRoom(floating: boolean, fullScreen: boolean, chrome: WindowChrome = WINDOW_CHROME): number {
  if (fullScreen) return 0;
  return captionRoom(floating ? PEEK_LEFT + PEEK_BORDER : 0, 0, chrome);
}

export const newTabPinned = (chip: number, tabsEnd: number, pageWidth: number, tabsShrink = true) =>
  (chip <= COMPACT_CHIP || !tabsShrink) && tabsEnd + GAP + NEW_TAB_ROOM > pageWidth + 0.5;
