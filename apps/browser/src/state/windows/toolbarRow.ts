import { create } from "zustand";
import { snappedToDevicePixels } from "../settings/interfaceScale";

export const useToolbarRows = create<Record<string, number>>()(() => ({}));

export function noteToolbarRowCenter(windowId: string, center: number | null) {
  const rows = useToolbarRows.getState();
  const next = center === null ? undefined : snappedToDevicePixels(center);
  if (rows[windowId] === next) return;
  if (next === undefined) useToolbarRows.setState(Object.fromEntries(Object.entries(rows).filter(([id]) => id !== windowId)), true);
  else useToolbarRows.setState({ [windowId]: next });
}

export const useToolbarRowCenter = (windowId: string): number | undefined => useToolbarRows((s) => s[windowId]);
