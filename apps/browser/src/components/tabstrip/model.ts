import type { Animated } from "react-native";
import type { DropSpot } from "../../state/drag/drops";
import { dropTabsAt, dropTabsInSlot } from "../../state/tabs/topStrip";
import type { DragGeometry } from "./stripGroups";
import type { StripScroll } from "./stripScroll";

export const chipKey = (groupId: string) => `strip-group-chip|${groupId}`;
export const folderKey = (groupId: string) => `strip-folder-chip|${groupId}`;
export const nameKey = (groupId: string) => `strip-group-name|${groupId}`;

export type StripDrag = {
  tabId: string | null;
  ids: () => string[];
  pinned: boolean;
  groupId: string | null;
  geometry: DragGeometry;
  from: number;
  width: number;
  gap: number;
  axis?: "x" | "y";
  range?: [number, number] | ((grab: number) => [number, number]);
  drop?: (dx: number, ids: string[]) => boolean;
  cross?: Cross;
  levels?: number;
  local?: boolean;
  scroll?: StripScroll | null;
};

export type Landing = { dx: number; commit: () => void };
export type Cross = { at: (dx: number, grab: number) => boolean; land: (dx: number, grab: number, ids: string[]) => Landing | null; clear: () => void };

export type Dock = { ids: string[]; left: number; geometry: DragGeometry };
export type Strip = { dock: Dock | null; top: DragGeometry; chip: number; grow: Animated.Value; slotOf: (tabId: string) => number; animateWidths: boolean };

export function reorder(ids: string[], { geometry, from, pinned, groupId }: StripDrag, to: number): boolean {
  return dropTabsInSlot(ids, geometry.slots, from, to, { pinned, groupId });
}

export function dropAt(ids: string[], spot: DropSpot): boolean {
  return dropTabsAt(ids, { kind: "tab" }, spot);
}

export type GroupOut = { top: DragGeometry; slot: number; chip: number; expanded: boolean; left: number };

export type Release = { kind: "handedOff" } | { kind: "across"; landing: Landing } | { kind: "dropped" } | { kind: "settle" };

type ReleaseSteps = {
  local: boolean;
  lifted: boolean;
  from: number;
  drops: boolean;
  crossed: boolean;
  endWindowDrag(): boolean;
  landAcross(): Landing | null | undefined;
  clearAim(): void;
  move(): boolean;
};

export function releaseDrop(s: ReleaseSteps): Release {
  if ((!s.local && (s.endWindowDrag() || s.lifted)) || (s.from < 0 && !s.drops)) return { kind: "handedOff" };
  const landing = s.crossed ? s.landAcross() : null;
  if (landing) return { kind: "across", landing };
  s.clearAim();
  if (!s.local && s.move()) return { kind: "dropped" };
  return s.from < 0 ? { kind: "handedOff" } : { kind: "settle" };
}
