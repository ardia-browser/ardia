import { showMenu, type MenuItem } from "../../platform/menus";
import { useBrowser, type BrowserState } from "../browser/store";
import { COMMANDS } from "../commands/commandCatalog";
import { menuShortcut } from "../commands/commandShortcuts";
import { runCommand } from "../commands/commands";
import { browserLayoutMenuItem, runBrowserLayoutChoice } from "../sidebar/sidebarMenu";
import { consentToken } from "../telemetry/client";
import { checkForUpdates } from "./appSettings";
import { menuSections } from "./menuSections";

type Listed = "newTab" | "newWindow" | "newIncognitoWindow" | "showHistory" | "downloads" | "findInPage" | "print" | "openSettings" | "keyboardShortcuts" | "reportProblem" | "releaseNotes";

const CHECK_FOR_UPDATES = "checkForUpdates";

const SYMBOLS: Record<Listed, string> = {
  newTab: "plus.app",
  newWindow: "macwindow.badge.plus",
  newIncognitoWindow: "eyeglasses",
  showHistory: "clock",
  downloads: "arrow.down.circle",
  findInPage: "magnifyingglass",
  print: "printer",
  openSettings: "gearshape",
  keyboardShortcuts: "keyboard",
  reportProblem: "exclamationmark.triangle",
  releaseNotes: "sparkles",
};

const listed = (command: Listed): MenuItem => ({ id: command, title: COMMANDS[command].title, symbol: SYMBOLS[command], ...menuShortcut(command) });

export const appMenuItems = (s: BrowserState, windowId: string): MenuItem[] =>
  menuSections(
    [listed("newTab"), listed("newWindow"), listed("newIncognitoWindow")],
    [listed("showHistory"), listed("downloads")],
    [listed("findInPage"), listed("print")],
    s.windows[windowId]?.kind === "small" ? [] : [browserLayoutMenuItem(s, windowId)],
    [
      listed("openSettings"),
      {
        id: "help",
        title: "Help",
        symbol: "questionmark.circle",
        children: [listed("keyboardShortcuts"), listed("releaseNotes"), { id: CHECK_FOR_UPDATES, title: "Check for Updates…", symbol: "arrow.triangle.2.circlepath" }, listed("reportProblem")],
      },
    ],
  );

export async function showAppMenu(windowId: string) {
  const consent = consentToken();
  const choice = await showMenu(appMenuItems(useBrowser.getState(), windowId));
  if (!choice || runBrowserLayoutChoice(windowId, choice, consent)) return;
  if (choice === CHECK_FOR_UPDATES) return void checkForUpdates();
  runCommand({ command: choice as Listed, arg: null, windowId }, { user: { consent } });
}
