import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

export type DragsEnded = { ownerGone: number; debuggerUnowned: number; nativeRefused: number };

const KINDS = ["ownerGone", "debuggerUnowned", "nativeRefused"] as const;
const none = (): DragsEnded => ({ ownerGone: 0, debuggerUnowned: 0, nativeRefused: 0 });

let seen = none();
let pending = none();

const FIELDS = { ownerGone: "stuck_drags_ended_owner_gone", debuggerUnowned: "stuck_drags_ended_debugger", nativeRefused: "stuck_drags_ended_refused" } as const;

export function noteDragsEnded(totals: DragsEnded | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const ended = none();
  for (const kind of KINDS) {
    const total = Number(totals[kind]) || 0;
    ended[kind] = Math.max(0, total - seen[kind]);
    seen[kind] = Math.max(seen[kind], total);
  }
  if (KINDS.some((kind) => ended[kind])) countFor(consent, () => KINDS.forEach((kind) => (pending[kind] += ended[kind])), Object.fromEntries(KINDS.map((kind) => [FIELDS[kind], ended[kind]])));
}

export function takeStuckDragCounts() {
  const taken = pending;
  pending = none();
  return Object.fromEntries(KINDS.map((kind) => [FIELDS[kind], taken[kind]])) as Record<(typeof FIELDS)[keyof typeof FIELDS], number>;
}
