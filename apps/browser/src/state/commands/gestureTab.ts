import type { CommandEvent } from "../../platform/commands";
import type { BrowserState } from "../browser/store";
import { isSmall } from "../windows/small";
import { LITTLE_ARDIA_DISABLED_COMMANDS } from "./commandCatalog";

type GestureEvent = Pick<CommandEvent, "command" | "mouseGesture" | "gestureTabId" | "windowId">;

export type GestureRoute = { run: boolean; tabId: string | null };

const DROPPED: GestureRoute = { run: false, tabId: null };

export function gestureRoute(s: BrowserState, e: GestureEvent): GestureRoute {
  if (!e.mouseGesture) return { run: true, tabId: null };
  if (!e.windowId || !s.windows[e.windowId]) return DROPPED;
  const tabId = e.gestureTabId || null;
  if (!tabId || s.tabs[tabId]?.windowId !== e.windowId) return DROPPED;
  if (isSmall(s, e.windowId)) return LITTLE_ARDIA_DISABLED_COMMANDS.includes(e.command) ? DROPPED : { run: true, tabId: null };
  return { run: true, tabId };
}
