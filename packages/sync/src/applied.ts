import type { Origin, ScopeState } from "./scopeState.ts";

export const covered = (vv: Record<string, number>, [device, seq]: Origin) => (vv[device] ?? 0) >= seq;

function sortedIndex(list: number[], seq: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function markApplied(state: ScopeState, device: string, seq: number) {
  if (covered(state.vv, [device, seq])) return;
  const extra = state.extra[device] ?? [];
  const at = sortedIndex(extra, seq);
  if (extra[at] !== seq) extra.splice(at, 0, seq);
  let top = state.vv[device] ?? 0;
  let taken = 0;
  while (extra[taken] === top + 1) top = extra[taken++]!;
  state.vv[device] = top;
  const left = taken ? extra.slice(taken) : extra;
  if (left.length) state.extra[device] = left;
  else delete state.extra[device];
}

export const isApplied = (state: ScopeState, [device, seq]: Origin) => {
  if (covered(state.vv, [device, seq])) return true;
  const extra = state.extra[device];
  return !!extra && extra[sortedIndex(extra, seq)] === seq;
};

export function raiseApplied(state: ScopeState, device: string, seq: number) {
  if (seq <= (state.vv[device] ?? 0)) return;
  state.vv[device] = seq;
  const extra = (state.extra[device] ?? []).filter((s) => s > seq);
  let taken = 0;
  for (let top = seq; extra[taken] === top + 1; top++) state.vv[device] = extra[taken++]!;
  const left = extra.slice(taken);
  if (left.length) state.extra[device] = left;
  else delete state.extra[device];
}
