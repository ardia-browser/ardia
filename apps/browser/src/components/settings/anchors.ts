import type { View } from "react-native";

const anchors = new Map<string, View>();
const waiting = new Map<string, Set<(view: View) => void>>();

export const anchorView = (id: string) => anchors.get(id);

export const settingTestId = (id: string) => `setting:${id}`;

export const sectionAnchorId = (pane: string, section: string) => `section\u0000${pane}\u0000${section}`;

export function whenAnchorMounts(id: string, then: (view: View) => void): () => void {
  const listeners = waiting.get(id) ?? new Set();
  listeners.add(then);
  waiting.set(id, listeners);
  return () => {
    listeners.delete(then);
    if (!listeners.size && waiting.get(id) === listeners) waiting.delete(id);
  };
}

export function registerAnchor(id: string, view: View) {
  anchors.set(id, view);
  for (const then of [...(waiting.get(id) ?? [])]) then(view);
  return () => {
    if (anchors.get(id) === view) anchors.delete(id);
  };
}
