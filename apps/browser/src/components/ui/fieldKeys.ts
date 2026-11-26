import { useMemo } from "react";

type ExtraKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type ExtraKeyProps = { extraKeys?: readonly ExtraKey[]; onExtraKey?: (pressed: ExtraKey) => boolean };

export function useKeyDownEvents(base: readonly ExtraKey[] | undefined, extra: readonly ExtraKey[] | undefined): ExtraKey[] | undefined {
  return useMemo(() => (extra?.length ? [...(base ?? []), ...extra] : base ? [...base] : undefined), [base, extra]);
}

export const HELD_ESCAPE_GAP_MS = 1200;

const ESCAPE_UP = [{ key: "Escape" }];

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

export type HeldEscape = { downAt: number | null };

export const ESCAPE_RELEASED: HeldEscape = { downAt: null };

export function escapeDown(state: HeldEscape, now: number, repeat?: boolean): { state: HeldEscape; held: boolean } {
  return {
    state: { downAt: now },
    held: typeof repeat === "boolean" ? repeat : state.downAt !== null && now - state.downAt < HELD_ESCAPE_GAP_MS,
  };
}

export function heldEscapeKeyDown(state: HeldEscape, key: string, now: number, repeat?: boolean): { state: HeldEscape; held: boolean } {
  if (key === "Escape") return escapeDown(state, now, repeat);
  if (MODIFIER_KEYS.has(key)) return { state, held: false };
  return { state: ESCAPE_RELEASED, held: false };
}

type KeyEventLike = { nativeEvent: { key: string; repeat?: boolean } };

export function createHeldEscape(now: () => number = Date.now) {
  let state = ESCAPE_RELEASED;
  const up = (e: KeyEventLike) => void (e.nativeEvent.key === "Escape" && (state = ESCAPE_RELEASED));
  return {
    down(e: KeyEventLike) {
      const next = heldEscapeKeyDown(state, e.nativeEvent.key, now(), e.nativeEvent.repeat);
      state = next.state;
      return next.held;
    },
    up,
    release: () => void (state = ESCAPE_RELEASED),
    upProps: { keyUpEvents: ESCAPE_UP, onKeyUp: up },
  };
}

const sharedHeldEscape = createHeldEscape();

export function useHeldEscape() {
  return sharedHeldEscape;
}
