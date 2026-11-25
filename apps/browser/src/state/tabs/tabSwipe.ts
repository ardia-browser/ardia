import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { numberedTabs } from "../sidebar/entries";
import { noteTabSwipe } from "../telemetry/usage";
import { activate } from "./actions";

export type TabSwipeSurface = "toolbar" | "sidebarField";

export function swipeToNeighbourTab(windowId: string, delta: -1 | 1, surface: TabSwipeSurface): string | null {
  const s = useBrowser.getState();
  const rows = numberedTabs(s, windowId);
  const active = activeTabId(s, windowId);
  const at = active ? rows.indexOf(active) : -1;
  const target = at < 0 ? undefined : rows[at + delta];
  noteTabSwipe(surface, !!target);
  if (!target) return null;
  activate(target);
  return target;
}
