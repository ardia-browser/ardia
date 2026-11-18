import type { View } from "react-native";
import { create } from "zustand";
import { snappedToDevicePixels } from "../settings/interfaceScale";

export type Anchor = { x: number; y: number; width: number; height: number };
export type Target = { kind: "tab" | "group" | "live" | "folder"; id: string };
export type Hover = Target & { windowId: string; anchor: Anchor };

type SidebarUi = {
  renaming: (Target & { windowId: string }) | null;
  iconPicker: (Target & { windowId: string; anchor: Anchor | null }) | null;
  hover: Hover | null;
  searchTabs: string | null;
  switcher: { windowId: string; ids: string[]; index: number; visible: boolean } | null;
};

export const useSidebarUi = create<SidebarUi>()(() => ({
  renaming: null,
  iconPicker: null,
  hover: null,
  searchTabs: null,
  switcher: null,
}));

export const sidebarUi = () => useSidebarUi.getState();
export const setSidebarUi = (patch: Partial<SidebarUi>) => useSidebarUi.setState(patch);

export const useSidebarResize = create<{ widths: Record<string, number> }>()(() => ({ widths: {} }));

export const sidebarResizing = (windowId: string) => windowId in useSidebarResize.getState().widths;

export function watchSidebarResize(windowId: string, changed: (resizing: boolean) => void) {
  let resizing = sidebarResizing(windowId);
  return useSidebarResize.subscribe((r) => {
    if (windowId in r.widths !== resizing) changed((resizing = !resizing));
  });
}

export function setLiveSidebarWidth(windowId: string, width: number | null) {
  const shown = width === null ? undefined : snappedToDevicePixels(width);
  const { widths } = useSidebarResize.getState();
  if (widths[windowId] === shown) return;
  const { [windowId]: _, ...rest } = widths;
  useSidebarResize.setState({ widths: shown === undefined ? rest : { ...rest, [windowId]: shown } });
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
