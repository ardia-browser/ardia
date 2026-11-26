import { useSyncExternalStore } from "react";
import { setTrafficLightsCenter as placeTrafficLights, type LightsPlace } from "../../platform/windows";

export { closeWindow, focusWindow, onWindowEvent, raiseView, watchSidebarEdge } from "../../platform/windows";
export { discardKeyResponder, restoreKeyResponder, saveKeyResponder } from "../../platform/focus";

const placedLights = new Map<string, LightsPlace>();
const placedLightsWatchers = new Set<() => void>();

export function setTrafficLightsCenter(id: string, center: LightsPlace | null) {
  const before = placedLights.get(id);
  if (center) placedLights.set(id, center);
  else placedLights.delete(id);
  if (before?.[1] !== center?.[1]) for (const watcher of [...placedLightsWatchers]) watcher();
  return placeTrafficLights(id, center);
}

function watchPlacedLights(listener: () => void) {
  placedLightsWatchers.add(listener);
  return () => void placedLightsWatchers.delete(listener);
}

export function useTrafficLightsCenterY(windowId: string | null): number | null {
  return useSyncExternalStore(watchPlacedLights, () => (windowId ? (placedLights.get(windowId)?.[1] ?? null) : null));
}
