import type { BrowserCommand } from "../../platform/commands";
import type { Settings } from "../settings/settings";
import { parseShortcut, type ShortcutSource } from "./shortcuts";
import { defaultKeys, profileSwitchKey } from "./keyNotation";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { splitViewAvailable } from "../splits/splits";
import { t } from "../../lib/uiLanguage";


type Keys = readonly string[];
type Scope = "page" | "window";
type InLittleArdia = "page" | "off";
type Variant = { title?: string; barTitle?: string; symbol?: string; keys?: Keys };
type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type ChoiceSetting = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];
export type CommandSpec = Variant & {
  scope?: Scope;
  onInternalPages?: true;
  app?: true;
  littleArdia?: InLittleArdia;
  variants?: Readonly<Record<string, Variant>>;
  toggles?: BooleanSetting;
  chooses?: ChoiceSetting;
};

const inWindow = { scope: "window" } as const;
const appWide = { app: true } as const;
const pageInLittleArdia = { scope: "page", littleArdia: "page" } as const;
const offInLittleArdia = { littleArdia: "off" } as const;
const windowOffInLittleArdia = { scope: "window", littleArdia: "off" } as const;

export const COMMANDS = {
  newTab: { title: t(`New Tab`), symbol: "plus", keys: ["⌘T"] },
  newWindow: { title: t(`New Window`), symbol: "macwindow", keys: ["⌘N"] },
  newIncognitoWindow: { title: t(`New Incognito Window`), symbol: "eyeglasses", keys: ["⇧⌘N"] },
  newLittleArdia: { title: t(`New Little Ardia Window`), keys: ["⌥⌘N"] },
  toggleOpenLinksInLittleArdia: { title: t(`Open Links from Other Apps in Main Window`) },
  reopenClosedTab: { title: t(`Reopen Closed Tab`), symbol: "arrow.uturn.backward", keys: ["⇧⌘T"], littleArdia: "page" },
  reopenClosedWindow: { title: t(`Reopen Closed Window`) },
  restoreClosed: { littleArdia: "page" },
  clearRecentlyClosed: { title: t(`Clear Recently Closed`), symbol: "trash", ...appWide },
  focusCommandBar: { title: t(`Open Command Bar`), keys: ["⌘L", "⌃F5"], ...inWindow },
  closeTab: { title: t(`Close Tab`), symbol: "xmark", keys: ["⌘W"], ...inWindow },
  closeAllTabs: { title: t(`Close All Tabs`), symbol: "xmark.square", keys: ["⇧⌘K"], ...windowOffInLittleArdia },
  print: { title: t(`Print…`), symbol: "printer", keys: ["⌘P"], ...pageInLittleArdia },
  copyUrl: { title: t(`Copy URL`), symbol: "link", keys: ["⇧⌘C"], ...pageInLittleArdia, onInternalPages: true },
  copyUrlAsMarkdown: { title: t(`Copy URL as Markdown`), symbol: "link", keys: ["⌥⇧⌘C"], ...pageInLittleArdia, onInternalPages: true },
  findInPage: { title: t(`Find…`), barTitle: t(`Find in Page`), symbol: "text.magnifyingglass", keys: ["⌘F"], ...pageInLittleArdia },
  findNext: { title: t(`Find Next`), keys: ["⌘G"], ...pageInLittleArdia },
  findPrevious: { title: t(`Find Previous`), keys: ["⇧⌘G"], ...pageInLittleArdia },
  hideElement: { title: t(`Hide Element…`), barTitle: t(`Hide an Element on This Page`), symbol: "eye.slash", keys: ["⇧⌘H"], ...pageInLittleArdia },
  showHiddenElements: { title: t(`Hidden Elements on This Site…`), barTitle: t(`Show Hidden Elements on This Site`), symbol: "eye", keys: ["⇧⌘U"], ...pageInLittleArdia },
  setAppearance: {
    chooses: "appearance",
    variants: {
      auto: { title: t(`Automatic`), barTitle: t(`Use System Appearance`), symbol: "circle.lefthalf.filled" },
      light: { title: t(`Light`), barTitle: t(`Light Appearance`), symbol: "sun.max" },
      dark: { title: t(`Dark`), barTitle: t(`Dark Appearance`), symbol: "moon" },
    },
  },
  reload: { title: t(`Refresh`), barTitle: t(`Reload Page`), symbol: "arrow.clockwise", keys: ["⌘R"], ...pageInLittleArdia },
  forceReload: { title: t(`Force Refresh the Page`), barTitle: t(`Force Reload Page`), symbol: "arrow.clockwise", keys: ["⇧⌘R"], ...pageInLittleArdia },
  toggleTabLayout: { title: t(`Show Tabs in Sidebar`), keys: ["⇧⌘S"], ...windowOffInLittleArdia },
  toggleSidebarSide: { title: t(`Sidebar on Right`), symbol: "sidebar.right", ...offInLittleArdia },
  toggleSidebar: { title: t(`Auto-Hide Tabs`), symbol: "sidebar.left", keys: ["⌘S", "⇧⌘L", "⇧⌘F"], ...windowOffInLittleArdia },
  openSplitPane: { title: t(`Open Split Pane`), keys: ["⌃⇧=", "⌃+"], ...windowOffInLittleArdia },
  useSelectionForFind: { title: t(`Use Selection for Find`), keys: ["⌘E"], ...pageInLittleArdia },
  findAndReplace: { title: t(`Find and Replace…`), keys: ["⌥⌘F"], ...pageInLittleArdia },
  jumpToSelection: { title: t(`Jump to Selection`), keys: ["⌘J"], ...pageInLittleArdia },
  focusNextPane: { title: t(`Focus Next Split Pane`), keys: ["⌃⇧]", "⌃}"], ...offInLittleArdia },
  focusPreviousPane: { title: t(`Focus Previous Split Pane`), keys: ["⌃⇧[", "⌃{"], ...offInLittleArdia },
  toggleFullUrl: { title: t(`Show Full URL`), symbol: "text.alignleft", toggles: "showFullUrl" },
  toggleJavaScriptFromAppleEvents: { title: t(`Allow JavaScript from Apple Events`), toggles: "allowJavaScriptFromAppleEvents" },
  toggleAddressBar: { title: t(`Show Address Bar in Sidebar`), ...offInLittleArdia },
  toggleMinimalism: { title: t(`Minimalism Mode`), barTitle: t(`Toggle Minimalism Mode`), symbol: "rectangle.leftthird.inset.filled", keys: ["⌃⌘M"], toggles: "minimalismMode", ...offInLittleArdia },
  cast: { title: t(`Cast…`), littleArdia: "page" },
  zoomReset: { title: t(`Zoom to Actual Size`), barTitle: t(`Actual Size`), symbol: "1.magnifyingglass", keys: ["⌘0"], ...pageInLittleArdia },
  zoomIn: { title: t(`Zoom In`), symbol: "plus.magnifyingglass", keys: ["⌘+", "⌘="], ...pageInLittleArdia },
  zoomOut: { title: t(`Zoom Out`), symbol: "minus.magnifyingglass", keys: ["⌘-"], ...pageInLittleArdia },
  devTools: { title: t(`Developer Tools`), symbol: "hammer", keys: ["⌥⌘I"], ...pageInLittleArdia },
  toggleDevTools: { title: t(`Toggle Developer Tools`), keys: [t(`F12`)], ...pageInLittleArdia },
  javaScriptConsole: { title: t(`JavaScript Console`), keys: ["⌥⌘J"], ...pageInLittleArdia },
  inspectElements: { title: t(`Inspect Elements`), keys: ["⌥⌘C"], ...pageInLittleArdia },
  viewSource: { title: t(`View Source`), keys: ["⌥⌘U"], ...pageInLittleArdia },
  back: { title: t(`Go Back`), keys: ["⌘[", "⌘←"], scope: "window", littleArdia: "page" },
  forward: { title: t(`Go Forward`), keys: ["⌘]", "⌘→"], scope: "window", littleArdia: "page" },
  nextTab: { title: t(`Next Tab`), keys: ["⇧⌘]", "⌘}", "⌃⇥", "⌃⇟", "⌥⌘↓"], ...windowOffInLittleArdia },
  previousTab: { title: t(`Previous Tab`), keys: ["⇧⌘[", "⌘{", "⌃⇧⇥", "⌃⇞", "⌥⌘↑"], ...windowOffInLittleArdia },
  selectTab: {
    ...windowOffInLittleArdia,
    variants: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), { title: `Select Tab ${n}`, keys: [`⌘${n}`] }])),
  },
  selectLastTab: { title: t(`Select Last Tab`), keys: ["⌘9"], ...windowOffInLittleArdia },
  togglePin: {
    title: t(`Move to Top Apps`),
    symbol: "pin",
    ...windowOffInLittleArdia,
    variants: { tile: { title: t(`Move Pinned Tab to Top Apps`) }, row: {} },
  },
  togglePinnedRow: { title: t(`Move to Pinned`), keys: ["⌥⇧⌘D"], ...windowOffInLittleArdia },
  duplicateTab: { title: t(`Duplicate`), barTitle: t(`Duplicate Tab`), symbol: "plus.square.on.square", ...windowOffInLittleArdia },
  moveTabToProfile: windowOffInLittleArdia,
  moveTabToWindow: windowOffInLittleArdia,
  bookmarkPage: { title: t(`Add to Bookmarks…`), symbol: "bookmark", keys: ["⌘D"], ...pageInLittleArdia, onInternalPages: true },
  addBookmarkToFolder: { ...pageInLittleArdia, onInternalPages: true },
  openBookmark: { scope: "window", littleArdia: "page" },
  addFolderToSidebar: {},
  restoreArcFolders: {},
  toggleMute: { title: t(`Mute Tab`), symbol: "speaker.slash", ...pageInLittleArdia },
  togglePageEngine: { title: t(`Open Page in WebKit`) },
  toggleReader: { title: t(`Show Reader`), barTitle: t(`Toggle Reading Mode`), symbol: "doc.plaintext", keys: ["⌥⌘R"], ...pageInLittleArdia },
  downloads: { title: t(`Downloads`), symbol: "arrow.down.circle", keys: ["⇧⌘J", "⌥⌘L"], scope: "window", littleArdia: "page" },
  mergeAllWindows: { title: t(`Merge All Windows`), symbol: "rectangle.stack", ...windowOffInLittleArdia },
  switchProfile: inWindow,
  nextProfile: { title: t(`Next Profile`), keys: ["⌥⌘→"], ...inWindow },
  previousProfile: { title: t(`Previous Profile`), keys: ["⌥⌘←"], ...inWindow },
  newProfile: { title: t(`New Profile…`), symbol: "person.crop.circle.badge.plus" },
  openSettings: { title: t(`Settings…`), symbol: "gearshape", keys: ["⌘,"] },
  importBrowserData: { title: t(`Import from Another Browser…`), barTitle: t(`Import Browser Data`), symbol: "square.and.arrow.down" },
  showHistory: { title: t(`Show History…`), barTitle: t(`History`), symbol: "clock", keys: ["⌘Y"] },
  clearBrowsingData: { title: t(`Clear Browsing Data…`), symbol: "trash", keys: ["⇧⌘⌫"] },
  manageBookmarks: { title: t(`Manage Bookmarks`), barTitle: t(`Bookmarks`), symbol: "book", keys: ["⌥⌘B"] },
  exportBookmarks: { title: t(`Export Bookmarks…`), symbol: "square.and.arrow.up" },
  bookmarkAllTabs: { title: t(`Bookmark All Tabs…`), keys: ["⇧⌘D"], ...offInLittleArdia },
  setBookmarksBar: { chooses: "bookmarksBar", variants: { always: { title: t(`Always`) }, newTab: { title: t(`On New Tab Only`) }, never: { title: t(`Never`) } } },
  toggleBookmarksBar: { title: t(`Toggle Bookmarks Bar`), symbol: "menubar.rectangle", keys: ["⇧⌘B"] },
  newTabInGroup: { title: t(`New Tab in Group`), keys: ["⌥⌘T", "⌃⌘C"], ...windowOffInLittleArdia },
  newGroupWithTabs: { title: t(`New Group with Tab`), symbol: "folder.badge.plus", keys: ["⌃⌘N", "⌃⌘P"], ...windowOffInLittleArdia },
  cleanUpTabs: { title: t(`Clean Up Tabs`), symbol: "sparkles", keys: ["⌥⌘K"], ...windowOffInLittleArdia },
  tidyPins: { title: t(`Tidy Pins`), symbol: "sparkles" },
  searchTabs: { title: t(`Search Tabs…`), symbol: "magnifyingglass", keys: ["⇧⌘A"], ...windowOffInLittleArdia },
  renameTab: { title: t(`Rename…`), barTitle: t(`Rename Tab`), symbol: "pencil", ...windowOffInLittleArdia },
  changeTabIcon: { title: t(`Change Icon…`), ...windowOffInLittleArdia },
  returnToPinnedUrl: { title: t(`Back to Pinned URL`), keys: ["⌘↩"], ...windowOffInLittleArdia },
  tabSwitcher: {
    ...windowOffInLittleArdia,
    variants: {
      forward: { title: t(`Tab Switcher (forward)`) },
      backward: { title: t(`Tab Switcher (backward)`) },
    },
  },
  share: { title: t(`Share…`), symbol: "square.and.arrow.up", keys: ["⌥⌘S"], ...pageInLittleArdia },
  reportProblem: { title: t(`Report a Problem…`), keys: ["⌥⇧⌘I"], ...appWide },
  keyboardShortcuts: { title: t(`Keyboard Shortcuts`), symbol: "keyboard" },
  copyDiagnostics: { title: t(`Copy Diagnostics`), ...appWide },
  copyLastFreeze: { title: t(`Copy Last Freeze`), ...appWide },
  toolTour: { title: t(`Tool Tour`), ...appWide },
  videoTour: { title: t(`Video Tour`), ...appWide },
  releaseNotes: { title: t(`Release Notes`), ...appWide },
  showOnboarding: { title: t(`Show Onboarding`), ...appWide },
  taskManager: { title: t(`Task Manager`), ...appWide },
  openExtension: { littleArdia: "page" },
  addExtension: { title: t(`Add Extension…`), littleArdia: "page" },
  manageExtensions: { title: t(`Manage Extensions…`) },
  pinExtensions: { title: t(`Pin Extensions…`) },
  autofill: {
    littleArdia: "page",
    variants: { contact: { title: t(`Contact…`) }, passwords: { title: t(`Passwords…`) }, creditCard: { title: t(`Credit Card…`) } },
  },
  openFile: { title: t(`Open File…`), keys: ["⌘O"] },
  savePage: { title: t(`Save Page As…`), ...pageInLittleArdia },
  emailPageLocation: { title: t(`Email Page Location`), keys: ["⇧⌘I"], ...pageInLittleArdia },
  printWithSystemDialog: { title: t(`Print Using System Dialog…`), keys: ["⌥⌘P"], ...pageInLittleArdia },
  stop: { title: t(`Stop`), keys: ["⌘."], ...pageInLittleArdia },
  caretBrowsing: { title: t(`Caret Browsing`), keys: [t(`F7`)], ...pageInLittleArdia },
  moveTabDown: { title: t(`Move Tab Down`), keys: ["⌃⇧⇟"], ...windowOffInLittleArdia },
  moveTabUp: { title: t(`Move Tab Up`), keys: ["⌃⇧⇞"], ...windowOffInLittleArdia },
  closeTabGroup: { title: t(`Close Group`), keys: ["⌃⌘W"], ...windowOffInLittleArdia },
  openProfileMenu: { title: t(`Show Profiles Menu`), keys: ["⇧⌘M"], ...inWindow },
} as const satisfies Record<BrowserCommand, CommandSpec>;

const SPECS: Readonly<Record<BrowserCommand, CommandSpec>> = COMMANDS;

type Specs = typeof COMMANDS;
export type AppCommand = { [C in BrowserCommand]: Specs[C] extends { app: true } ? C : never }[BrowserCommand];
export type VariantOf<C extends BrowserCommand> = Specs[C] extends { variants: infer V } ? keyof V & string : never;

export const STANDARD_ITEMS: Readonly<Record<string, { keys?: Keys }>> = {
  "std:quit:": { keys: ["⌘Q"] },
  "std:hide:": { keys: ["⌘H"] },
  "std:hideOtherApplications:": { keys: ["⌥⌘H"] },
  "std:unhideAllApplications:": {},
  "std:closeWindow:": { keys: ["⇧⌘W"] },
  "std:undo:": { keys: ["⌘Z"] },
  "std:redo:": { keys: ["⇧⌘Z"] },
  "std:cut:": { keys: ["⌘X"] },
  "std:copy:": { keys: ["⌘C"] },
  "std:paste:": { keys: ["⌘V"] },
  "std:pasteAndMatchStyle:": { keys: ["⇧⌘V", "⌥⇧⌘V"] },
  "std:delete:": {},
  "std:selectAll:": { keys: ["⌘A"] },
  "std:showGuessPanel:": { keys: ["⌘:"] },
  "std:checkSpelling:": { keys: ["⌘;"] },
  "std:toggleContinuousSpellChecking:": {},
  "std:toggleGrammarChecking:": {},
  "std:toggleAutomaticSpellingCorrection:": {},
  "std:orderFrontSubstitutionsPanel:": {},
  "std:toggleSmartInsertDelete:": {},
  "std:toggleAutomaticQuoteSubstitution:": {},
  "std:toggleAutomaticDashSubstitution:": {},
  "std:toggleAutomaticLinkDetection:": {},
  "std:toggleAutomaticDataDetection:": {},
  "std:toggleAutomaticTextReplacement:": {},
  "std:uppercaseWord:": {},
  "std:lowercaseWord:": {},
  "std:capitalizeWord:": {},
  "std:startSpeaking:": {},
  "std:stopSpeaking:": {},
  "std:toggleFullScreen:": { keys: ["🌐F", "⌃⌘F"] },
  "std:performMiniaturize:": { keys: ["⌘M"] },
  "std:miniaturizeAll:": { keys: ["⌥⌘M"] },
  "std:performZoom:": {},
  "std:arrangeWindowsInFront:": {},
  "std:toggleKeepOnTop:": {},
};

const ALL_COMMANDS = Object.keys(COMMANDS) as BrowserCommand[];
const commandsWhere = (test: (spec: CommandSpec) => boolean) => ALL_COMMANDS.filter((command) => test(SPECS[command]));

export const PAGE_COMMANDS = commandsWhere((c) => c.scope === "page");
export const PAGE_COMMANDS_OFF_INTERNAL_PAGES = commandsWhere((c) => c.scope === "page" && !c.onInternalPages);
export const WINDOW_COMMANDS = commandsWhere((c) => c.scope !== undefined);
export const LITTLE_ARDIA_DISABLED_COMMANDS = commandsWhere((c) => c.littleArdia === "off");
export const SPLIT_VIEW_COMMANDS: readonly BrowserCommand[] = ["openSplitPane", "focusNextPane", "focusPreviousPane"];
export const EXPORT_COMMANDS: readonly BrowserCommand[] = ["exportBookmarks"];
export const WEBKIT_COMMANDS: readonly BrowserCommand[] = ["togglePageEngine"];
export const HIDING_COMMANDS: readonly BrowserCommand[] = ["hideElement", "showHiddenElements"];
export const UNAVAILABLE_COMMANDS: ReadonlySet<string> = new Set([
  ...(splitViewAvailable ? [] : SPLIT_VIEW_COMMANDS),
  ...(PLATFORM_FEATURES.exportsBookmarksAndPasswords ? [] : EXPORT_COMMANDS),
  ...(PLATFORM_FEATURES.webKit ? [] : WEBKIT_COMMANDS),
  ...(PLATFORM_FEATURES.contentBlocker ? [] : HIDING_COMMANDS),
]);
export const LITTLE_ARDIA_PAGE_COMMANDS: ReadonlySet<string> = new Set(commandsWhere((c) => c.littleArdia === "page"));

const APP_COMMANDS: ReadonlySet<string> = new Set(commandsWhere((c) => !!c.app));
export const isAppCommand = (command: BrowserCommand): command is AppCommand => APP_COMMANDS.has(command);

export function variantArg<C extends BrowserCommand>(command: C, arg: string | null | undefined): VariantOf<C> | undefined {
  const variants = SPECS[command].variants;
  return arg && variants && Object.hasOwn(variants, arg) ? (arg as VariantOf<C>) : undefined;
}

export function settingChange(command: BrowserCommand, arg: string | null | undefined, settings: Settings): Partial<Settings> | undefined {
  const { toggles, chooses } = SPECS[command];
  if (toggles) return { [toggles]: !settings[toggles] };
  const choice = variantArg(command, arg);
  return chooses && choice ? { [chooses]: choice } : undefined;
}

export function settingChecks(settings: Settings): string[] {
  return ALL_COMMANDS.flatMap((command) => {
    const { toggles, chooses } = SPECS[command];
    if (toggles) return settings[toggles] ? [command] : [];
    return chooses ? [`${command}:${settings[chooses]}`] : [];
  });
}

const variantOf = (command: BrowserCommand, arg: string | undefined): Variant => {
  const spec = SPECS[command];
  return (arg && spec.variants?.[arg]) || spec;
};

export const commandTitle = (command: BrowserCommand, arg?: string): string | undefined => variantOf(command, arg).title;

export function commandBarTitle(command: BrowserCommand, arg?: string): string {
  const { barTitle, title = "" } = variantOf(command, arg);
  return barTitle ?? title.replace(/…$/, "");
}

export const commandSymbol = (command: BrowserCommand, arg?: string): string | undefined => variantOf(command, arg).symbol ?? SPECS[command].symbol;

const PROFILE_SHORTCUT_COUNT = 9;
const OVERRIDABLE_PER_ITEM_COMMANDS: readonly BrowserCommand[] = ["openExtension"];

const source = (id: string, keys: Keys = []): ShortcutSource => ({ id, keys: keys.map(parseShortcut) });

export function staticShortcutSources(): ShortcutSource[] {
  const sources: ShortcutSource[] = [];
  for (const command of ALL_COMMANDS) {
    const spec = SPECS[command];
    sources.push(source(command, defaultKeys(command, spec.keys)));
    for (const [arg, variant] of Object.entries(spec.variants ?? {})) sources.push(source(`${command}:${arg}`, defaultKeys(`${command}:${arg}`, variant.keys)));
  }
  for (const [id, item] of Object.entries(STANDARD_ITEMS)) sources.push(source(id, defaultKeys(id, item.keys)));
  return sources;
}

const STATIC_SOURCES = staticShortcutSources();

export function shortcutSources(profileIds: readonly string[], overriddenIds: readonly string[]): ShortcutSource[] {
  const perItem = overriddenIds.filter((id) => OVERRIDABLE_PER_ITEM_COMMANDS.some((command) => id.startsWith(`${command}:`)));
  return [
    ...STATIC_SOURCES,
    ...profileIds.flatMap((id, i) => [
      source(`switchProfile:${id}`, i < PROFILE_SHORTCUT_COUNT ? [profileSwitchKey(i + 1)] : []),
      source(`newLittleArdia:${id}`),
    ]),
    ...perItem.map((id) => source(id)),
  ];
}
