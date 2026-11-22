import type { CommandAction } from "@ardia/core";
import type { BrowserCommand } from "../../platform/commands";
import { isBookmarked } from "../bookmarks/bookmarks";
import { hidesBookmarkCommand } from "../bookmarks/visibility";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTab, bookmarkProfileId, isPinnedRow, pinnedSectionTitle, tabLayoutOf } from "../browser/model";
import { canTidy } from "../pins/tidy";
import { commandBarTitle, commandSymbol, LITTLE_ARDIA_DISABLED_COMMANDS, UNAVAILABLE_COMMANDS } from "../commands/commandCatalog";
import { menuBarRevision, shortcutHint } from "../commands/commandShortcuts";
import type { Tab } from "../browser/types";
import { organizeActions } from "./organizeActions";
import { muteState, muteTitle, siteMuteTitle } from "../tabs/mute";
import { isWebPageUrl } from "../../lib/url";
import { pluginActionsRevision, pluginBarActions } from "../plugins/commands";
import { currentPlugins } from "../plugins/store";
import { eligibleKind } from "../automation/automationWindows";
import { isSmallWindow } from "../windows/small";
import { t } from "../../lib/uiLanguage";


type Context = { s: BrowserState; windowId: string; tab: Tab | undefined };

type ActionDef = {
  command: BrowserCommand;
  arg?: string;
  title?: (c: Context) => string;
  icon?: string | ((c: Context) => string);
  keywords?: string[];
  needs?: "page" | "webPage" | "tab" | "profiles" | "pins";
};

const page = "page" as const;

const layoutSwitchesTo = ({ s, windowId }: Context) => (tabLayoutOf(s, windowId) === "sidebar" ? "top" : "sidebar");

const DEFS: ActionDef[] = [
  { command: "newTab", keywords: [t(`open tab`)] },
  { command: "newWindow" },
  { command: "newIncognitoWindow", keywords: [t(`private window`), "incognito"] },
  { command: "closeTab", needs: "tab" },
  { command: "closeAllTabs", keywords: [t(`clear unpinned tabs`), t(`close unpinned tabs`), t(`clear today`)] },
  { command: "reopenClosedTab", keywords: [t(`undo close`), t(`restore tab`)] },
  {
    command: "togglePin",
    title: ({ tab }) => (isPinnedRow(tab) ? t(`Unpin Tab`) : tab?.pin ? t(`Unpin from Top Apps`) : t(`Move to Top Apps`)),
    keywords: ["pin", "unpin", t(`pin tab`), t(`unpin tab`), t(`remove from top apps`), "favorites"],
    needs: "tab",
  },
  {
    command: "togglePin",
    arg: "row",
    title: ({ s, tab }) => (isPinnedRow(tab) ? t(`Move to Top Apps`) : `Move to ${pinnedSectionTitle(s, tab)}`),
    icon: "list.bullet",
    keywords: ["pin", t(`pinned tabs`), t(`pin as row`), t(`move to pinned`), "favorites"],
    needs: "tab",
  },
  { command: "duplicateTab", needs: "tab" },
  { command: "renameTab", needs: "tab" },
  { command: "searchTabs" },
  { command: "cleanUpTabs", keywords: [t(`tidy tabs`)] },
  { command: "tidyPins", keywords: [t(`tidy pinned tabs`), t(`organize pins`), t(`pinned folders`), t(`remove duplicate pins`)], needs: "pins" },
  { command: "newGroupWithTabs", keywords: [t(`tab group`)], needs: "tab" },
  { command: "reload", keywords: ["refresh"], needs: page },
  { command: "forceReload", keywords: [t(`hard reload`), t(`hard refresh`)], needs: page },
  { command: "toggleMute", title: ({ s, tab }) => muteTitle(tab ? muteState(s, tab) : null), keywords: ["mute", "unmute", "silence", t(`mute tab`)], needs: page },
  {
    command: "toggleMute",
    arg: "site",
    title: ({ s, tab }) => siteMuteTitle(tab ? muteState(s, tab) : null),
    icon: "speaker.slash",
    keywords: [t(`mute site`), t(`unmute site`), t(`silence site`)],
    needs: page,
  },
  { command: "copyUrl", keywords: [t(`copy link`)], needs: page },
  { command: "copyUrlAsMarkdown", keywords: [t(`markdown link`)], needs: page },
  { command: "findInPage", needs: page },
  {
    command: "bookmarkPage",
    title: ({ s, windowId, tab }) =>
      tab?.url && isBookmarked(s, bookmarkProfileId(s, s.windows[windowId]), tab.url) ? t(`Remove Bookmark`) : t(`Bookmark This Page`),
    keywords: [t(`add bookmark`), "bookmark"],
    needs: page,
  },
  { command: "print", needs: page },
  { command: "share", keywords: ["airdrop", t(`share link`), t(`send link`)], needs: page },
  { command: "zoomIn", needs: page },
  { command: "zoomOut", needs: page },
  { command: "zoomReset", keywords: [t(`reset zoom`)], needs: page },
  { command: "devTools", keywords: ["inspect", "devtools", "console"], needs: page },
  { command: "inspectElements", icon: "cursorarrow", keywords: [t(`inspect element`), t(`element picker`)], needs: page },
  { command: "javaScriptConsole", icon: "terminal.fill", keywords: [t(`js console`)], needs: page },
  { command: "viewSource", icon: "chevron.left.forwardslash.chevron.right", keywords: [t(`page source`)], needs: "webPage" },
  { command: "savePage", icon: "square.and.arrow.down", keywords: [t(`save as`)], needs: page },
  { command: "cast", icon: "tv", keywords: [t(`cast tab`)], needs: page },
  { command: "toggleFullUrl", title: ({ s }) => (s.settings.showFullUrl ? t(`Hide Full URL`) : t(`Show Full URL`)) },
  {
    command: "toggleTabLayout",
    title: (c) => (layoutSwitchesTo(c) === "top" ? t(`Show Tabs Across the Top`) : t(`Show Tabs in Sidebar`)),
    icon: (c) => (layoutSwitchesTo(c) === "top" ? "rectangle.topthird.inset.filled" : c.s.settings.sidebarSide === "right" ? "sidebar.right" : "sidebar.left"),
    keywords: [t(`tab layout`), t(`top tabs`), t(`tabs on top`), t(`tabs across the top`), t(`horizontal tabs`), t(`horizontal row`), t(`tab bar`), t(`tab strip`), t(`vertical tabs`), t(`vertical sidebar`), t(`sidebar tabs`), t(`tabs in sidebar`)],
  },
  { command: "toggleSidebar", keywords: [t(`toggle sidebar`), t(`hide sidebar`), t(`show sidebar`), t(`focus mode`)] },
  { command: "toggleBookmarksBar", keywords: [t(`bookmarks bar`)] },
  { command: "downloads", keywords: [t(`show downloads`), "dl"] },
  { command: "taskManager", icon: "chart.bar", keywords: [t(`open task manager`)] },
  { command: "manageExtensions", icon: "puzzlepiece.extension" },
  { command: "addExtension", icon: "puzzlepiece", keywords: [t(`install extension`)] },
  { command: "newLittleArdia", icon: "macwindow.badge.plus", keywords: [t(`little arc`), t(`mini window`)] },
  { command: "showHistory", keywords: [t(`show history`)] },
  { command: "manageBookmarks", keywords: [t(`manage bookmarks`), t(`show bookmarks`)] },
  { command: "openSettings", keywords: ["preferences", "prefs", "options"] },
  { command: "clearBrowsingData", keywords: [t(`clear history`), t(`clear cache`), t(`clear cookies`)] },
  { command: "importBrowserData", keywords: [t(`import bookmarks`), t(`import passwords`)] },
  { command: "exportBookmarks", keywords: [t(`export bookmarks`), t(`backup bookmarks`), t(`bookmarks html`)] },
  { command: "keyboardShortcuts", keywords: ["shortcuts", "hotkeys"] },
  { command: "mergeAllWindows", needs: "profiles" },
  { command: "newProfile", keywords: [t(`create profile`)], needs: "profiles" },
  { command: "setAppearance", arg: "dark", keywords: [t(`dark mode`)] },
  { command: "setAppearance", arg: "light", keywords: [t(`light mode`)] },
  { command: "setAppearance", arg: "auto", keywords: [t(`auto appearance`), t(`system appearance`)] },
];

const actionId = (d: Pick<ActionDef, "command" | "arg">) => (d.arg ? `${d.command}:${d.arg}` : d.command);

const LITTLE_ARDIA_HIDDEN: ReadonlySet<string> = new Set(LITTLE_ARDIA_DISABLED_COMMANDS);

export function barActions(s: BrowserState, windowId: string): CommandAction[] {
  const w = s.windows[windowId];
  const small = isSmallWindow(w);
  const tab = activeTab(s, windowId);
  const c: Context = { s, windowId, tab };
  const out: CommandAction[] = [];
  for (const d of DEFS) {
    if (d.needs === "page" && !tab?.url) continue;
    if (d.needs === "webPage" && !isWebPageUrl(tab?.url ?? "")) continue;
    if (d.needs === "tab" && !tab) continue;
    if (d.needs === "profiles" && w?.kind === "private") continue;
    if (d.needs === "pins" && !canTidy(s, windowId)) continue;
    if (hidesBookmarkCommand(s.settings, d.command) || UNAVAILABLE_COMMANDS.has(d.command)) continue;
    if (small && LITTLE_ARDIA_HIDDEN.has(d.command)) continue;
    const id = actionId(d);
    const hint = shortcutHint(id, s);
    out.push({
      id,
      title: d.title?.(c) ?? commandBarTitle(d.command, d.arg),
      icon: (typeof d.icon === "function" ? d.icon(c) : d.icon) ?? commandSymbol(d.command, d.arg),
      ...(hint ? { hint } : {}),
      ...(d.keywords ? { keywords: d.keywords } : {}),
    });
  }
  if (w && w.kind !== "private") {
    s.profileOrder.forEach((id) => {
      if (id === w.profileId) return;
      const name = s.profiles[id]?.name ?? "";
      const action = `switchProfile:${id}`;
      out.push({ id: action, title: `Switch to ${name}`, icon: "person.crop.circle", hint: shortcutHint(action, s), keywords: [name, "profile", "space"] });
    });
  }
  out.push(...organizeActions(s, windowId));
  if (eligibleKind(s, windowId)) out.push(...pluginBarActions(currentPlugins(), windowId));
  return out;
}

const barActionsOf = new WeakMap<BrowserState, Map<string, CommandAction[]>>();

export function currentBarActions(windowId: string): CommandAction[] {
  const s = useBrowser.getState();
  let byWindow = barActionsOf.get(s);
  if (!byWindow) barActionsOf.set(s, (byWindow = new Map()));
  const key = `${windowId}|${menuBarRevision()}|${pluginActionsRevision()}`;
  let actions = byWindow.get(key);
  if (!actions) byWindow.set(key, (actions = barActions(s, windowId)));
  return actions;
}
