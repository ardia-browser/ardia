import { create, type StoreApi } from "zustand";

export type SplitHalfMark = { key: string; side: "left" | "right" };
export type GhostShapeMark = { w: number; h: number };
export type GhostPaneMark = GhostShapeMark & { x: number; y: number; corner: number };

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
