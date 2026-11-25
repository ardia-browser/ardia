import { Animated, type View } from "react-native";
import { create } from "zustand";
import { snappedToDevicePixels } from "../settings/interfaceScale";
import { peekShown } from "../windows/dockMotion";
import { noteSidebarPeekResize } from "../telemetry/dockCounts";

export type Anchor = { x: number; y: number; width: number; height: number };
export type Target = { kind: "tab" | "group" | "live" | "folder"; id: string };
export type Hover = Target & { windowId: string; anchor: Anchor };

type SidebarUi = {
  renaming: (Target & { windowId: string }) | null;
  iconPicker: (Target & { windowId: string; anchor: Anchor | null }) | null;
  tileLetters: { windowId: string; tabId: string; anchor: Anchor | null } | null;
  hover: Hover | null;
  searchTabs: string | null;
  switcher: { windowId: string; ids: string[]; index: number; mounted: boolean; visible: boolean } | null;
  resizing: Record<string, true>;
};

export const useSidebarUi = create<SidebarUi>()(() => ({
  renaming: null,
  iconPicker: null,
  tileLetters: null,
  hover: null,
  searchTabs: null,
  switcher: null,
  resizing: {},
}));

export const sidebarUi = () => useSidebarUi.getState();
export const setSidebarUi = (patch: Partial<SidebarUi>) => useSidebarUi.setState(patch);

const liveWidths = new Map<string, Animated.Value>();

export function liveSidebarWidth(windowId: string, initial = 0): Animated.Value {
  let value = liveWidths.get(windowId);
  if (!value) liveWidths.set(windowId, (value = new Animated.Value(initial)));
  return value;
}

export const forgetLiveSidebarWidth = (windowId: string) => void liveWidths.delete(windowId);

export function setLiveSidebarWidth(windowId: string, width: number | null) {
  const held = windowId in useSidebarUi.getState().resizing;
  if (width === null) {
    if (held) useSidebarUi.setState(({ resizing: { [windowId]: _, ...rest } }) => ({ resizing: rest }));
    return;
  }
  liveSidebarWidth(windowId).setValue(snappedToDevicePixels(width));
  if (held) return;
  if (peekShown(windowId)) noteSidebarPeekResize();
  useSidebarUi.setState((u) => ({ resizing: { ...u.resizing, [windowId]: true } }));
}

const rows = new Map<string, Map<string, View>>();

export function registerRow(windowId: string, id: string, view: View | null) {
  let byId = rows.get(windowId);
  if (!byId) rows.set(windowId, (byId = new Map()));
  if (view) byId.set(id, view);
  else byId.delete(id);
}

export const rowIds = (windowId: string): string[] => [...(rows.get(windowId)?.keys() ?? [])];

export function rowView(windowId: string, id: string): View | undefined {
  return rows.get(windowId)?.get(id);
}

export function measureRow(windowId: string, id: string): Promise<Anchor | null> {
  const view = rowView(windowId, id);
  if (!view) return Promise.resolve(null);
  return new Promise((resolve) => view.measureInWindow((x, y, width, height) => resolve(width ? { x, y, width, height } : null)));
}
