import { create } from "zustand";
import type { ArdiaHost } from "./host.ts";

export const MAXIMIZE_BUTTON_STATE_EVENT = "maximizeButtonState";

export type MaximizeButtonState = {
  readonly hovered: boolean;
  readonly pressed: boolean;
};

export const IDLE_MAXIMIZE_BUTTON_STATE: MaximizeButtonState = Object.freeze({
  hovered: false,
  pressed: false,
});

export function parseMaximizeButtonState(
  payload: unknown,
): { windowId: string; state: MaximizeButtonState } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.hovered !== "boolean" || typeof record.pressed !== "boolean") return null;
  if (record.windowId !== undefined && typeof record.windowId !== "string") return null;
  return {
    windowId: typeof record.windowId === "string" ? record.windowId : "",
    state: { hovered: record.hovered, pressed: record.pressed },
  };
}

const useMaximizeButtonStates = create<Record<string, MaximizeButtonState>>()(() => ({}));

export const useMaximizeButtonState = (windowId: string): MaximizeButtonState =>
  useMaximizeButtonStates((states) => states[windowId] ?? IDLE_MAXIMIZE_BUTTON_STATE);

export function noteMaximizeButtonState(windowId: string, state: MaximizeButtonState) {
  useMaximizeButtonStates.setState((states) => {
    const current = states[windowId] ?? IDLE_MAXIMIZE_BUTTON_STATE;
    if (current.hovered === state.hovered && current.pressed === state.pressed) return states;
    if (!state.hovered && !state.pressed) {
      const { [windowId]: _, ...rest } = states;
      return rest;
    }
    return { ...states, [windowId]: { hovered: state.hovered, pressed: state.pressed } };
  }, true);
}

export function resetMaximizeButtonState(windowId: string) {
  noteMaximizeButtonState(windowId, IDLE_MAXIMIZE_BUTTON_STATE);
}

export function followMaximizeButtonState(
  host: ArdiaHost,
  windowId: string,
  note: (id: string, state: MaximizeButtonState) => void = noteMaximizeButtonState,
): () => void {
  const stop = host.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell" || event !== MAXIMIZE_BUTTON_STATE_EVENT) return;
    const parsed = parseMaximizeButtonState(payload);
    if (!parsed) return;
    if (parsed.windowId && parsed.windowId !== windowId) return;
    note(windowId, parsed.state);
  });
  return () => {
    stop();
    note(windowId, IDLE_MAXIMIZE_BUTTON_STATE);
  };
}
