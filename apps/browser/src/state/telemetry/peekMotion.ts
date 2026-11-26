import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

type PeekEntranceKind = "genie" | "affine" | "fade";

const none = () => ({ genie: 0, affine: 0, fade: 0, fallbacks: 0, readyTimeouts: 0, interrupts: 0, promotes: 0, closes: 0, closeAsks: 0, closeStays: 0 });

let counts = none();

export function notePeekEntrance(entrance: PeekEntranceKind, fellBack: boolean, readyTimedOut: boolean) {
  counts[entrance]++;
  if (fellBack) counts.fallbacks++;
  if (readyTimedOut) counts.readyTimeouts++;
}

export const notePeekInterrupt = () => void counts.interrupts++;

let closeKeyClosesWithFind = 0;

export const notePeekClosedByCloseKeyWithFind = (consent: ConsentToken | null) => countFor(consent, () => void closeKeyClosesWithFind++);

export function notePeekCloseAsked(leave: boolean) {
  counts.closeAsks++;
  if (!leave) counts.closeStays++;
}

export const notePeekDone = (outcome: "closed" | "promoted") => void counts[outcome === "promoted" ? "promotes" : "closes"]++;

export function takePeekMotionCounts() {
  const taken = counts, withFind = closeKeyClosesWithFind;
  counts = none();
  closeKeyClosesWithFind = 0;
  return {
    peek_entrances_genie: taken.genie,
    peek_entrances_affine: taken.affine,
    peek_entrances_fade: taken.fade,
    peek_mesh_fallbacks: taken.fallbacks,
    peek_ready_timeouts: taken.readyTimeouts,
    peek_entrance_interrupts: taken.interrupts,
    peek_promotes: taken.promotes,
    peek_closes: taken.closes,
    peek_close_asks: taken.closeAsks,
    peek_close_stays: taken.closeStays,
    peek_close_key_closes_with_find: withFind,
  };
}
