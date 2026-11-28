import type { CommandEvent } from "../../platform/commands";
import type { BrowserState } from "../browser/store";
import { isSmall } from "../windows/small";
import { LITTLE_ARDIA_DISABLED_COMMANDS } from "./commandCatalog";

type GestureEvent = Pick<CommandEvent, "command" | "mouseGesture" | "gestureTabId" | "windowId">;

export type GestureRoute = { run: boolean; tabId: string | null };

export function gestureRoute(s: BrowserState, e: GestureEvent): GestureRoute {
  if (!e.mouseGesture) return { run: true, tabId: null };
  if (isSmall(s, e.windowId)) return { run: !LITTLE_ARDIA_DISABLED_COMMANDS.includes(e.command), tabId: null };
  if (!e.gestureTabId) return { run: true, tabId: null };
  const tab = s.tabs[e.gestureTabId];
  return tab && e.windowId && tab.windowId === e.windowId ? { run: true, tabId: e.gestureTabId } : { run: false, tabId: null };
}
