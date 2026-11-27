import { create } from "zustand";

export const useSidebarRowGeometry = create<Record<string, number>>()(() => ({}));

const movedIn = new Set<string>();

export function noteSidebarRowMoved(windowId: string) {
  if (movedIn.has(windowId)) return;
  movedIn.add(windowId);
  requestAnimationFrame(() => {
    if (!movedIn.delete(windowId)) return;
    useSidebarRowGeometry.setState((s) => ({ [windowId]: (s[windowId] ?? 0) + 1 }));
  });
}

export function forgetSidebarRowGeometry(windowId: string) {
  movedIn.delete(windowId);
  useSidebarRowGeometry.setState((s) => Object.fromEntries(Object.entries(s).filter(([id]) => id !== windowId)), true);
}

export const useSidebarRowsVersion = (windowId: string): number => useSidebarRowGeometry((s) => s[windowId] ?? 0);
