import type { View } from "react-native";

const anchors = new Map<string, View>();
const listeners = new Map<string, Set<() => void>>();

export const anchorView = (id: string) => anchors.get(id);

export function onAnchorRegistered(id: string, listener: () => void) {
  const forId = listeners.get(id) ?? new Set();
  forId.add(listener);
  listeners.set(id, forId);
  return () => {
    forId.delete(listener);
    if (forId.size === 0) listeners.delete(id);
  };
}

export function registerAnchor(id: string, view: View) {
  anchors.set(id, view);
  listeners.get(id)?.forEach((listener) => listener());
  return () => {
    if (anchors.get(id) === view) anchors.delete(id);
  };
}
