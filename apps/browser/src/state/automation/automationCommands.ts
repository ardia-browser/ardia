import type { BrowserCommand } from "../../platform/commands";
import { COMMANDS, commandBarTitle, UNAVAILABLE_COMMANDS } from "../commands/commandCatalog";
import { isConfigSettingKey } from "../settings/configAllowlist";

export type AutomationDecision = "run" | "endsApp" | "changesEngine" | "leftOutSetting" | "control" | "needsArgument" | "needsPerson";

export const AUTOMATION: Readonly<Record<BrowserCommand, AutomationDecision>> = {
  newTab: "run",
  newWindow: "run",
  newIncognitoWindow: "run",
  newLittleArdia: "run",
  toggleOpenLinksInLittleArdia: "run",
  reopenClosedTab: "run",
  reopenClosedWindow: "run",
  restoreClosed: "needsArgument",
  clearRecentlyClosed: "run",
  focusCommandBar: "run",
  closeTab: "run",
  closeAllTabs: "run",
  print: "needsPerson",
  copyUrl: "run",
  copyUrlAsMarkdown: "run",
  findInPage: "run",
  findNext: "run",
  findPrevious: "run",
  hideElement: "needsPerson",
  showHiddenElements: "run",
  setAppearance: "run",
  reload: "run",
  forceReload: "run",
  toggleTabLayout: "run",
  toggleSidebar: "run",
  toggleSidebarSide: "run",
  openSplitPane: "run",
  useSelectionForFind: "run",
  findAndReplace: "run",
  jumpToSelection: "run",
  focusNextPane: "run",
  focusPreviousPane: "run",
  movePaneLeft: "run",
  movePaneRight: "run",
  toggleFullUrl: "run",
  toggleJavaScriptFromAppleEvents: "leftOutSetting",
  toggleAddressBar: "run",
  toggleMinimalism: "run",
  cast: "needsPerson",
  zoomReset: "run",
  zoomIn: "run",
  zoomOut: "run",
  devTools: "run",
  toggleDevTools: "run",
  javaScriptConsole: "run",
  inspectElements: "run",
  viewSource: "run",
  back: "run",
  forward: "run",
  nextTab: "run",
  previousTab: "run",
  selectTab: "run",
  selectLastTab: "run",
  togglePin: "run",
  togglePinnedRow: "run",
  duplicateTab: "run",
  moveTabToProfile: "needsArgument",
  moveTabToWindow: "needsArgument",
  bookmarkPage: "run",
  addBookmarkToFolder: "needsArgument",
  openBookmark: "needsArgument",
  addFolderToSidebar: "needsArgument",
  restoreArcFolders: "needsArgument",
  toggleMute: "run",
  togglePageEngine: "changesEngine",
  toggleReader: "run",
  downloads: "run",
  mergeAllWindows: "run",
  switchProfile: "needsArgument",
  nextProfile: "run",
  previousProfile: "run",
  newProfile: "needsPerson",
  openSettings: "run",
  importBrowserData: "needsPerson",
  showHistory: "run",
  clearBrowsingData: "needsPerson",
  manageBookmarks: "run",
  exportBookmarks: "needsPerson",
  bookmarkAllTabs: "needsPerson",
  setBookmarksBar: "run",
  toggleBookmarksBar: "run",
  newTabInGroup: "run",
  newGroupWithTabs: "run",
  cleanUpTabs: "run",
  tidyPins: "run",
  searchTabs: "run",
  renameTab: "needsPerson",
  changeTabIcon: "needsPerson",
  returnToPinnedUrl: "run",
  tabSwitcher: "needsPerson",
  share: "needsPerson",
  reportProblem: "needsPerson",
  keyboardShortcuts: "run",
  copyDiagnostics: "run",
  copyLastFreeze: "run",
  toolTour: "needsPerson",
  videoTour: "run",
  releaseNotes: "run",
  showOnboarding: "needsPerson",
  taskManager: "run",
  openExtension: "needsArgument",
  addExtension: "run",
  manageExtensions: "run",
  pinExtensions: "needsPerson",
  autofill: "needsPerson",
  openFile: "needsPerson",
  savePage: "needsPerson",
  emailPageLocation: "needsPerson",
  printWithSystemDialog: "needsPerson",
  stop: "run",
  caretBrowsing: "needsPerson",
  moveTabDown: "run",
  moveTabUp: "run",
  closeTabGroup: "run",
  openProfileMenu: "needsPerson",
};

type SpecView = { title?: string; scope?: string; variants?: Readonly<Record<string, unknown>>; toggles?: string; chooses?: string };
const SPECS = COMMANDS as Readonly<Record<BrowserCommand, SpecView>>;

export const isCatalogCommand = (id: unknown): id is BrowserCommand => typeof id === "string" && Object.hasOwn(SPECS, id);

export const settingOf = (command: BrowserCommand): string | undefined => SPECS[command].toggles ?? SPECS[command].chooses;

export function automationDecision(command: BrowserCommand): AutomationDecision {
  const setting = settingOf(command);
  if (setting && !isConfigSettingKey(setting)) return AUTOMATION[command] === "run" ? "leftOutSetting" : AUTOMATION[command];
  return AUTOMATION[command] ?? "control";
}

export const isAutomatable = (command: BrowserCommand) => automationDecision(command) === "run";

export const variantsOf = (command: BrowserCommand): string[] | null => {
  const variants = SPECS[command].variants;
  return variants ? Object.keys(variants) : null;
};

export type AutomationCommand = { id: BrowserCommand; title: string; scope: string | null; variants: string[] | null };

export function automationCommands(): AutomationCommand[] {
  return (Object.keys(SPECS) as BrowserCommand[])
    .filter((id) => isAutomatable(id) && !UNAVAILABLE_COMMANDS.has(id))
    .map((id) => ({ id, title: SPECS[id].title ?? (commandBarTitle(id) || id), scope: SPECS[id].scope ?? null, variants: variantsOf(id) }));
}
