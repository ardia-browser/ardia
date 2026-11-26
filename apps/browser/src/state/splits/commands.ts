import type { BrowserCommand } from "../../platform/commands";
import type { ByUser } from "../tabs/closeActivation";
import { focusSplitPane, moveSplitPane, openSplitPane, openSplitPaneBelow, SPLIT_PANE_MOVES } from "./actions";

export function runSplitCommand(command: BrowserCommand, windowId: string, user?: ByUser): boolean {
  switch (command) {
    case "openSplitPane":
      openSplitPane(windowId);
      return true;
    case "openSplitPaneBelow":
      openSplitPaneBelow(windowId, {}, user?.consent);
      return true;
    case "moveSplitPaneLeft":
    case "moveSplitPaneRight":
    case "moveSplitPaneUp":
    case "moveSplitPaneDown":
      moveSplitPane(windowId, SPLIT_PANE_MOVES[command], user?.consent);
      return true;
    case "focusNextPane":
    case "focusPreviousPane":
      focusSplitPane(windowId, command === "focusNextPane" ? 1 : -1);
      return true;
  }
  return false;
}
