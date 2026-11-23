export type SelectionReveal = "none" | "drop" | "wait" | "run";

export function selectionReveal(revealed: string, activeId: string, heldClose: boolean, current: boolean, dragging: boolean, holding = false): SelectionReveal {
  if (revealed === activeId || heldClose) return "none";
  if (!activeId || dragging) return "drop";
  return current && !holding ? "run" : "wait";
}

export type FirstReveal = { shown: boolean; at: number; settling: boolean };

export const FIRST_REVEAL: FirstReveal = { shown: false, at: -Infinity, settling: false };

export function firstOverflowReveal(
  state: FirstReveal,
  o: { current: boolean; activeId: string; dragging: boolean; pressHeld: boolean; overflows: boolean; measuring: boolean; userScrollAt: number; now: number },
): { state: FirstReveal; reveal: boolean } {
  if (!o.current || !o.activeId || o.dragging || o.pressHeld || !o.overflows) return { state, reveal: false };
  if (!state.shown) return { state: { shown: true, at: o.now, settling: o.measuring }, reveal: true };
  if (!state.settling) return { state, reveal: false };
  if (o.userScrollAt > state.at) return { state: { ...state, settling: false }, reveal: false };
  return { state: { ...state, settling: o.measuring }, reveal: true };
}

export function endSettling(state: FirstReveal): FirstReveal {
  return state.settling ? { ...state, settling: false } : state;
}

export type ScrollCommand = { from: number; to: number; animated: boolean; furthest: number; until: number };

export type ScrollIntent = { baseline: number; command: ScrollCommand | null };

export const scrollIntentAt = (x: number): ScrollIntent => ({ baseline: x, command: null });

export function commandScroll(from: number, to: number, animated: boolean, until: number): ScrollIntent {
  return { baseline: from, command: { from, to: Math.max(0, to), animated, furthest: 0, until } };
}

export function observeScroll(intent: ScrollIntent, x: number, previous: number, max: number, now: number): { intent: ScrollIntent; user: boolean } {
  const end = Math.max(0, max);
  const clamped = (previous > end + 0.5 && Math.abs(x - end) <= 0.5) || (previous < -0.5 && Math.abs(x) <= 0.5);
  if (clamped) return { intent: { ...intent, baseline: x }, user: false };
  const command = intent.command && now <= intent.command.until ? intent.command : null;
  if (!command) {
    const baseline = intent.command ? previous : intent.baseline;
    return Math.abs(x - baseline) >= 1 ? { intent: scrollIntentAt(x), user: true } : { intent: intent.command ? scrollIntentAt(baseline) : intent, user: false };
  }
  const to = Math.min(command.to, end);
  if (Math.abs(x - to) <= 1) return { intent: scrollIntentAt(x), user: false };
  if (!command.animated) return { intent: scrollIntentAt(x), user: true };
  const way = Math.abs(to - command.from);
  const progress = (x - command.from) * Math.sign(to - command.from);
  if (progress < -0.5 || progress > way + 0.5 || progress < command.furthest - 1) return { intent: scrollIntentAt(x), user: true };
  return { intent: { ...intent, command: { ...command, furthest: Math.max(command.furthest, progress) } }, user: false };
}

export function userTookOver(first: FirstReveal, activeId: string): { first: FirstReveal; revealed: string } {
  return { first: endSettling(first), revealed: activeId };
}

export type PendingReveal = { tabId: string; scrolls: number };

export function revealStillWanted(pending: PendingReveal, now: { tabId: string; scrolls: number; current: boolean; dragging: boolean }): boolean {
  return now.current && !now.dragging && now.tabId === pending.tabId && now.scrolls === pending.scrolls;
}
