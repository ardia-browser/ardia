import type { View } from "react-native";
import type { StoreApi } from "zustand";
import { dragMarksOf, type DragMarks, markDrag } from "../../state/sidebar/dragMarks";
import { type Frame, inside, measure } from "./dragModel";

export const PROFILE_HOLD_MS = 500;
export const EDGE_HOLD_MS = 550;
export const EDGE_BAND = 16;

export type Edge = "left" | "right";

export const edgeStep = (side: Edge): -1 | 1 => (side === "left" ? -1 : 1);

export function edgeAt(sidebar: Frame, x: number, y: number): Edge | null {
  if (y < sidebar.y || y > sidebar.y + sidebar.h || sidebar.w < EDGE_BAND * 3) return null;
  if (x >= sidebar.x && x < sidebar.x + EDGE_BAND) return "left";
  if (x <= sidebar.x + sidebar.w && x > sidebar.x + sidebar.w - EDGE_BAND) return "right";
  return null;
}

export class HeldTimer<K extends string> {
  private held: K | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly ms: number;
  private readonly mark: (key: K | null) => void;

  constructor(ms: number, mark: (key: K | null) => void) {
    this.ms = ms;
    this.mark = mark;
  }

  hold(key: K | null, onHeld: (key: K) => void) {
    if (key === this.held) return;
    this.release();
    if (!key) return;
    this.held = key;
    this.mark(key);
    this.timer = setTimeout(() => {
      if (this.held !== key) return;
      this.release();
      onHeld(key);
    }, this.ms);
  }

  release() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.held === null) return;
    this.held = null;
    this.mark(null);
  }
}

export class ProfileTargets {
  readonly views = new Map<string, View | null>();
  private frames = new Map<string, Frame>();
  private readonly timer: HeldTimer<string>;

  constructor(marks: StoreApi<DragMarks>) {
    this.timer = new HeldTimer(PROFILE_HOLD_MS, (profileHold) => dragMarksOf(marks).profileHold !== profileHold && markDrag(marks, { profileHold }));
  }

  async measured(): Promise<Map<string, Frame>> {
    const measured = await Promise.all([...this.views].map(async ([id, view]) => [id, await measure(view)] as const));
    return new Map(measured.filter((entry): entry is readonly [string, Frame] => !!entry[1]));
  }

  use(frames: Map<string, Frame>) {
    this.frames = frames;
  }

  under(x: number, y: number): string | null {
    for (const [id, frame] of this.frames) if (inside(frame, x, y)) return id;
    return null;
  }

  hold(id: string | null, onHeld: (id: string) => void) {
    this.timer.hold(id, onHeld);
  }

  release() {
    this.timer.release();
  }
}
