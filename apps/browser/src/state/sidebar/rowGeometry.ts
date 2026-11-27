import { create } from "zustand";

type LaidOut = { version: number; content: string };

export const useSidebarRowGeometry = create<Record<string, LaidOut>>()(() => ({}));

export function noteSidebarRowsLaidOut(windowId: string, content: { width: number; height: number }) {
  const key = `${content.width}x${content.height}`;
  const was = useSidebarRowGeometry.getState()[windowId];
  if (was?.content === key) return;
  useSidebarRowGeometry.setState({ [windowId]: { version: (was?.version ?? 0) + 1, content: key } });
}

export const forgetSidebarRowGeometry = (windowId: string) => useSidebarRowGeometry.setState((s) => Object.fromEntries(Object.entries(s).filter(([id]) => id !== windowId)), true);

export const useSidebarRowsVersion = (windowId: string): number => useSidebarRowGeometry((s) => s[windowId]?.version ?? 0);
