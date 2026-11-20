import type { BrowserCommand } from "../../platform/commands";
import type { BrowserState } from "../browser/store";
import { activeTabId, resolveWindowId } from "../browser/model";
import { peekTabId, shownPeek } from "../peek/peek";
import { isUtilityWindowId, SETTINGS_WINDOW_ID } from "../settings/settingsWindows";
import { isSmall, mainWindowFor } from "../windows/small";
import { isAppCommand, LITTLE_ARDIA_PAGE_COMMANDS } from "./commandCatalog";

export const LITTLE_ARDIA_COMMANDS: ReadonlySet<string> = new Set(["closeTab", "focusCommandBar", "openFile", "switchProfile", "nextProfile", "previousProfile", "openProfileMenu"]);

export const peekHandles = (s: BrowserState, command: string, windowId: string) =>
  !!shownPeek(s, windowId) && (command === "openFile" || (command === "closeTab" && !s.windowUi[windowId]?.panel.open));

export type CommandTarget =
  | { kind: "app" }
  | { kind: "missingTab" }
  | { kind: "utility"; windowId: string }
  | { kind: "little"; windowId: string; tabId: string | null }
  | { kind: "peek"; windowId: string; tabId: string | null }
  | { kind: "window"; invokedFrom: string | null; requested: string | null; redirected: boolean; windowId: string | null; tabId: string | null; targeted: string | null };

export function commandTarget(s: BrowserState, command: BrowserCommand, given: string | null | undefined, targetTab: string | null = null): CommandTarget {
  if (isAppCommand(command)) return { kind: "app" };
  let requested = given ?? null;
  if (isUtilityWindowId(requested)) {
    if (command === "closeTab" || (command === "findInPage" && requested === SETTINGS_WINDOW_ID)) return { kind: "utility", windowId: requested! };
    requested = null;
  }
  const targeted = targetTab && s.tabs[targetTab] && (!requested || s.tabs[targetTab]!.windowId === requested) ? targetTab : null;
  if (targetTab && !targeted) return { kind: "missingTab" };
  if (!targeted && isSmall(s, requested) && LITTLE_ARDIA_COMMANDS.has(command)) return { kind: "little", windowId: requested!, tabId: activeTabId(s, requested!) ?? null };
  const shownIn = resolveWindowId(s, requested) ?? "";
  if (!targeted && peekHandles(s, command, shownIn)) return { kind: "peek", windowId: shownIn, tabId: shownPeek(s, shownIn)?.tabId ?? null };
  const redirected = !targeted && isSmall(s, requested) && !LITTLE_ARDIA_PAGE_COMMANDS.has(command);
  const after = redirected ? (mainWindowFor(s, s.windows[requested!]!.profileId) ?? null) : requested;
  const windowId = resolveWindowId(s, after) ?? null;
  const tabId = windowId ? (targeted ?? ((LITTLE_ARDIA_PAGE_COMMANDS.has(command) && peekTabId(s, windowId)) || activeTabId(s, windowId)) ?? null) : null;
  return { kind: "window", invokedFrom: requested, requested: after, redirected, windowId, tabId, targeted };
}
