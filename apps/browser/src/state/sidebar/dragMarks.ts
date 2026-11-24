import { create, type StoreApi } from "zustand";
import { keyedWatch, type KeyedWatch } from "../browser/keyedWatch";

export type SplitHalfMark = { key: string; side: "left" | "right" };
type GhostShapeMark = { w: number; h: number };
type GhostPaneMark = GhostShapeMark & { x: number; y: number; corner: number };

export type DragMarks = {
  sources: Set<string>;
  dropInto: string | null;
  split: SplitHalfMark | null;
  tile: GhostShapeMark | null;
  row: GhostShapeMark | null;
  pane: GhostPaneMark | null;
  landing: string | null;
  pins: boolean;
  pinCount: number;
  pinBefore: string | null;
  folded: string | null;
  folderTarget: string | null;
  folderAway: boolean;
  profileHold: string | null;
  overProfiles: boolean;
  edgeHold: "left" | "right" | null;
};

const NO_MARKS: DragMarks = { sources: new Set(), dropInto: null, split: null, tile: null, row: null, pane: null, landing: null, pins: false, pinCount: 0, pinBefore: null, folded: null, folderTarget: null, folderAway: false, profileHold: null, overProfiles: false, edgeHold: null };

export const createDragMarks = () => create<DragMarks>()(() => NO_MARKS);

export const noDragMarks = createDragMarks();

export const dragMarksOf = (marks: StoreApi<DragMarks>) => marks.getState();

export const markDrag = (marks: StoreApi<DragMarks>, patch: Partial<DragMarks>) => marks.setState(patch);

export const SOURCE = 1;
export const LANDING = 2;
export const SPLIT_LEFT = 4;
export const SPLIT_RIGHT = 8;

export const markOf = (m: DragMarks, key: string): number =>
  (m.sources.has(key) ? SOURCE : 0) | (m.landing === key ? LANDING : 0) | (m.split?.key === key ? (m.split.side === "left" ? SPLIT_LEFT : SPLIT_RIGHT) : 0);

const markWatches = new WeakMap<StoreApi<DragMarks>, KeyedWatch>();

export function watchMarks(marks: StoreApi<DragMarks>): KeyedWatch {
  let watch = markWatches.get(marks);
  if (!watch) {
    watch = keyedWatch(
      () => marks,
      (s, prev, wake) => {
        if (s.sources !== prev.sources) {
          for (const key of s.sources) wake(key);
          for (const key of prev.sources) wake(key);
        }
        if (s.landing !== prev.landing) {
          if (s.landing) wake(s.landing);
          if (prev.landing) wake(prev.landing);
        }
        if (s.split !== prev.split) {
          if (s.split) wake(s.split.key);
          if (prev.split) wake(prev.split.key);
        }
      },
    );
    markWatches.set(marks, watch);
  }
  return watch;
}

export const markNow = (marks: StoreApi<DragMarks>, key: string): number => markOf(marks.getState(), key);
