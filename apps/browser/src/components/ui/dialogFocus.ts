import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import type { View } from "react-native";

export type DialogButton = () => View | null;

export const DialogFocusContext = createContext<((button: DialogButton) => () => void) | null>(null);

export function useDialogButton(view: RefObject<View | null>, disabled: boolean | undefined) {
  const register = useContext(DialogFocusContext);
  const enabled = useRef(!disabled);
  enabled.current = !disabled;
  useEffect(() => register?.(() => (enabled.current ? view.current : null)), [register]);
}

export function nextDialogButton<Handle>(handles: readonly (Handle | null)[], target: unknown, dialog: unknown, back: boolean): number | null {
  const onButton = handles.some((handle) => handle !== null && handle === target);
  if (!onButton && target !== dialog) return null;
  const enabled = handles.flatMap((handle, index) => (handle === null ? [] : [index]));
  if (enabled.length === 0) return -1;
  const at = enabled.findIndex((index) => handles[index] === target);
  const next = at < 0 ? (back ? enabled.length - 1 : 0) : (at + (back ? enabled.length - 1 : 1)) % enabled.length;
  return enabled[next] ?? -1;
}
