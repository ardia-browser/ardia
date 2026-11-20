import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import {
  configureExtension,
  extensionActionStates,
  reloadExtension,
  setExtensionEnabled,
  uninstallExtension,
  type ActionState,
  type InstalledExtension,
} from "../../platform/extensions";
import { webStoreExtensionId } from "@ardia/core";
import { confirm } from "../../platform/dialogs";
import { showMenu, type MenuItem } from "../../platform/menus";
import type { ChoiceItem } from "../app/menuChoice";
import { menuSections } from "../app/menuSections";
import { focus, openWindow } from "../browser/actions";
import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { shownPageId } from "../peek/peek";
import { isOpenRegularWindow, mainWindowFor, originalProfile } from "../windows/small";
import { focusedWindowOf } from "../windows/ui";
import { goToSettingsPane, openSettings, replaceSettingsPlace, SETTINGS_DETAIL, useSettingsNav } from "../settings/settingsWindows";
import { clearSettingsSearch } from "../settings/searchState";
import { closeSidePanelsOf, toggleSidePanel } from "./sidePanels";
import { notePrivateWindowExtensionOpen, noteExtensionProfilePageOpen, noteToolbarExtensionMove } from "../telemetry/usage";
import { extensionPageUrl, extensionProfile, extensionsProfileId, isPrivate, nextInstallKey, pageProfile, shownIn, useExtensions, windowExtensions, readyTabOf, tabProfile, type Anchor } from "./store";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { freshExtensions, refreshExtensions, refreshExtensionsAfterChange } from "./lists";
import { cancelInstall, confirmInstall, showInstallSheet } from "./installSheet";
import { movedToolbarOrder, toolbarOrder, type ToolbarDrag } from "./toolbarOrder";

export * from "./sidePanels";
export * from "./store";
export * from "./lists";
export * from "./installSheet";

const EMPTY: InstalledExtension[] = [];
const WEB_STORE_HOME = "https://chromewebstore.google.com/category/extensions";

export function addFromWebStore(windowId: string, urlOrId: string, profile = extensionProfile(useBrowser.getState(), windowId)) {
  const id = webStoreExtensionId(urlOrId);
  if (!id) {
    showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "webStore", status: "error", error: "That isn't a link to an extension in the Chrome Web Store." });
    return;
  }
  openInExtensionProfile(`https://chromewebstore.google.com/detail/${id}`, profile, { windowId });
}

export const openWebStoreFor = (profile: string, profileId?: string | null) => openInExtensionProfile(WEB_STORE_HOME, profile, { profileId });

export function openInExtensionProfile(url: string, profile: string, { windowId, profileId }: { windowId?: string | null; profileId?: string | null } = {}) {
  const s = useBrowser.getState();
  const shows = (w: string | null | undefined): w is string =>
    !!w && !!s.windows[w] && (w === windowId || isOpenRegularWindow(s.windows[w])) && extensionProfile(s, w) === profile;
  const target = [windowId, ...s.ui.focusOrder, ...s.windowOrder].find(shows);
  noteExtensionProfilePageOpen(target !== (windowId && s.windows[windowId] ? windowId : focusedWindowOf(s)));
  if (target) {
    s.newTab(target, { url });
    focus(target);
  } else openWindow({ profileId: profileId && engineProfile(s, profileId) === profile ? profileId : s.profileOrder.find((p) => engineProfile(s, p) === profile), url });
}

export async function removeExtension(profile: string, ext: InstalledExtension, windowId?: string, mayRemove: () => boolean = () => true, ask: typeof confirm = confirm) {
  const { confirmed } = await ask({
    title: `Remove “${ext.name}”?`,
    message: ext.fromWebStore ? "Its data and settings will be removed too." : `The extension's folder stays on your ${PLATFORM_TERMS.computer}.`,
    confirmTitle: "Remove",
    destructive: true,
    windowId,
  });
  if (!confirmed || !mayRemove()) return;
  if (useExtensions.getState().popup?.extensionId === ext.id) closeExtensionPopup();
  closeSidePanelsOf(ext.id);
  await changeThenRefresh(profile, "remove", () => uninstallExtension(ext.id, profile));
}

export async function setEnabled(profile: string, id: string, enabled: boolean) {
  patchExtension(profile, id, { enabled, state: enabled ? "ENABLED" : "DISABLED" });
  await changeThenRefresh(profile, enabled ? "turn on" : "turn off", () => setExtensionEnabled(id, profile, enabled));
}

export async function setPinned(profile: string, id: string, pinned: boolean): Promise<boolean> {
  patchExtension(profile, id, { pinned });
  const consent = consentToken();
  const done = await changed(pinned ? "pin" : "unpin", () => configureExtension(id, profile, { pinned }), consent);
  if (!done) await refreshExtensions(profile, consent);
  return done;
}

export const setToolbarDrag = (windowId: string, drag: ToolbarDrag | null) => useExtensions.setState({ toolbarDrag: drag && { ...drag, windowId } });

export function endToolbarDrag(windowId: string) {
  if (useExtensions.getState().toolbarDrag?.windowId === windowId) useExtensions.setState({ toolbarDrag: null });
}

export async function moveToolbarExtension(windowId: string, id: string, to: number, via: "drag" | "menu") {
  const s = useBrowser.getState();
  if (isPrivate(s, windowId)) return;
  const profile = extensionProfile(s, windowId);
  const shown = toolbarOrder(windowExtensions(s, windowId));
  const moved = movedToolbarOrder(shown, id, to);
  if (!moved) return;
  const { slots } = moved;
  useExtensions.setState((e) => ({
    lists: { ...e.lists, [profile]: (e.lists[profile] ?? EMPTY).map((x) => (slots.has(x.id) ? { ...x, pinnedIndex: slots.get(x.id) } : x)) },
  }));
  noteToolbarExtensionMove(via);
  const consent = consentToken();
  const done = await changed("move", () => configureExtension(id, profile, { pinnedIndex: moved.pinnedIndex }), consent);
  if (!done) await refreshExtensions(profile, consent);
}

export async function configure(profile: string, id: string, options: Parameters<typeof configureExtension>[2]): Promise<boolean> {
  return changeThenRefresh(profile, "configure", () => configureExtension(id, profile, options));
}

export async function configureThenRead(profile: string, id: string, options: Parameters<typeof configureExtension>[2]): Promise<InstalledExtension[] | null> {
  const consent = consentToken();
  if (!(await changed("configure", () => configureExtension(id, profile, options), consent))) return null;
  return freshExtensions(profile);
}

export async function reload(profile: string, id: string): Promise<boolean> {
  return changeThenRefresh(profile, "reload", () => reloadExtension(id, profile));
}


async function changed(what: string, change: () => Promise<void>, consent: ConsentToken | null): Promise<boolean> {
  try {
    await change();
    return true;
  } catch (error) {
    if (consent) warnFor(consent, `[extensions] ${what} failed`, error);
    return false;
  }
}

async function changeThenRefresh(profile: string, what: string, change: () => Promise<void>): Promise<boolean> {
  const consent = consentToken();
  const done = await changed(what, change, consent);
  await refreshExtensionsAfterChange(profile, consent);
  return done;
}

function patchExtension(profile: string, id: string, patch: Partial<InstalledExtension>) {
  useExtensions.setState((e) => ({
    lists: { ...e.lists, [profile]: (e.lists[profile] ?? EMPTY).map((x) => (x.id === id ? { ...x, ...patch } : x)) },
  }));
}

export function openOptions(windowId: string, ext: InstalledExtension) {
  const url = ext.optionsUrl;
  if (!url) return;
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (w?.kind !== "private" || ext.incognitoSplit) return void s.newTab(windowId, { url });
  const profileId = originalProfile(s, w);
  const regular = profileId && mainWindowFor(s, profileId);
  if (!regular || s.windows[regular]!.profileId !== profileId) return void openWindow({ profileId, url });
  s.newTab(regular, { url });
  focus(regular);
}

export const openManageExtensions = (windowId?: string | null) => openSettings("profiles", extensionsProfileId(null, windowId));

export function openExtensionDetails(profileId: string, extensionId: string) {
  if (useSettingsNav.getState().profileId !== profileId) replaceSettingsPlace(profileId);
  goToSettingsPane("profiles", profileId, SETTINGS_DETAIL.extension(extensionId));
}

export const openPinDialog = (windowId: string) => useExtensions.setState({ pinDialog: { windowId } });
export const openWebStore = (windowId: string) => openInExtensionProfile(WEB_STORE_HOME, extensionProfile(useBrowser.getState(), windowId), { windowId });

export async function activateExtension(
  windowId: string,
  ext: InstalledExtension,
  anchor: Anchor,
  state?: ActionState | null,
  tabId = shownPageId(useBrowser.getState(), windowId),
) {
  const current = useExtensions.getState().popup;
  if (current?.windowId === windowId && current.extensionId === ext.id) return closeExtensionPopup();
  if (!ext.enabled) return void showExtensionMenu(windowId, ext);
  if (!shownIn(windowId, ext.id)) return;
  if (isPrivate(useBrowser.getState(), windowId)) notePrivateWindowExtensionOpen();
  const web = tabId ? webviews.get(tabId) : undefined;
  const result = web ? await web.executeExtensionAction(ext.id) : null;
  const readyTab = readyTabOf(tabId);
  if (!state && result === "popup" && readyTab) state = (await extensionActionStates(readyTab, [ext.id], tabProfile(readyTab)))[ext.id];
  const url = state ? state.popup : ext.popup ? extensionPageUrl(ext.id, ext.popup) : "";
  if (result === "none") return;
  if (result === "sidePanel") return void toggleSidePanel(windowId, ext.id);
  if (!url) return void (result === null && showExtensionMenu(windowId, ext));
  useExtensions.setState({ popup: { windowId, pageProfile: pageProfile(useBrowser.getState(), windowId), extensionId: ext.id, url, anchor } });
}

export const closeExtensionPopup = () => useExtensions.setState({ popup: null });

let popupRequests = 0;

export async function openActionPopup(windowId: string, extensionId: string, anchor: Anchor, sourceTabId: string) {
  const request = ++popupRequests;
  const consent = consentToken();
  const tabId = shownPageId(useBrowser.getState(), windowId);
  const url = (await extensionActionStates(sourceTabId, [extensionId], tabProfile(sourceTabId)))[extensionId]?.popup ?? "";
  if (request !== popupRequests || shownPageId(useBrowser.getState(), windowId) !== tabId)
    return warnFor(consent, `action.openPopup for ${extensionId}: the tab changed or another call came first`);
  if (!url) return warnFor(consent, `action.openPopup for ${extensionId}: no popup for the tab`);
  useExtensions.setState({ popup: { windowId, pageProfile: pageProfile(useBrowser.getState(), windowId), extensionId, url, anchor, opened: request } });
}

export function extensionMenuItems(ext: Pick<InstalledExtension, "name" | "enabled" | "pinned" | "optionsUrl" | "sidePanel" | "mayModify">, sidePanelOpen: boolean): MenuItem[] {
  return menuSections(
    [{ id: "name", title: ext.name, enabled: false }],
    [
      { id: "options", title: "Options", symbol: "gearshape", enabled: !!ext.optionsUrl && ext.enabled },
      !!ext.sidePanel && ext.enabled && { id: "sidePanel", title: sidePanelOpen ? "Close Side Panel" : "Open Side Panel", symbol: "sidebar.right" },
      { id: "pin", title: ext.pinned ? "Unpin from Toolbar" : "Pin to Toolbar", symbol: ext.pinned ? "pin.slash" : "pin" },
    ],
    [
      { id: "enable", title: ext.enabled ? "Turn Off" : "Turn On", symbol: "power" },
      { id: "manage", title: "Manage Extension", symbol: "puzzlepiece.extension" },
    ],
    [{ id: "remove", title: "Remove Extension…", symbol: "trash", enabled: ext.mayModify }],
  );
}

export async function showExtensionMenu(windowId: string, ext: InstalledExtension) {
  const profile = extensionProfile(useBrowser.getState(), windowId);
  const panel = useExtensions.getState().sidePanels[windowId];
  const choice = await showMenu(extensionMenuItems(ext, panel?.extensionId === ext.id && !panel.hidden));
  if (choice === "options") foreignWriteHooks.around(() => openOptions(windowId, ext));
  if (choice === "pin") void setPinned(profile, ext.id, !ext.pinned);
  if (choice === "enable") void setEnabled(profile, ext.id, !ext.enabled);
  if (choice === "remove") void removeExtension(profile, ext, windowId);
  if (choice === "sidePanel") void toggleSidePanel(windowId, ext.id);
  if (choice === "manage") {
    clearSettingsSearch();
    openExtensionDetails(extensionsProfileId(null, windowId), ext.id);
    openSettings();
  }
}

export type ExtensionListChoice = "add" | "manage" | "pin";

export const EXTENSION_LIST_ITEMS: ChoiceItem<never, ExtensionListChoice>[] = [
  { id: "add", title: "Add Extension…", symbol: "plus" },
  { id: "manage", title: "Manage Extensions…", symbol: "puzzlepiece.extension" },
  { id: "pin", title: "Pin Extensions…", symbol: "pin" },
];

export type ExtensionOverflowChoice = InstalledExtension | { front: InstalledExtension };

export function extensionOverflowItems(enabled: InstalledExtension[], hidden: InstalledExtension[]): ChoiceItem<ExtensionOverflowChoice, ExtensionListChoice | "front">[] {
  return [
    ...enabled.map((x) => ({ value: x, title: x.name, symbol: x.pinned ? "pin.fill" : undefined })),
    ...(enabled.length ? [{ separator: true as const }] : []),
    ...(hidden.length ? [{ id: "front" as const, title: "Move to Front", symbol: "arrow.left.to.line", children: hidden.map((x) => ({ value: { front: x }, title: x.name })) }, { separator: true as const }] : []),
    ...EXTENSION_LIST_ITEMS,
  ];
}

export function runExtensionListChoice(choice: ExtensionListChoice | null, windowId: string) {
  if (choice === "add") openWebStore(windowId);
  if (choice === "manage") openManageExtensions(windowId);
  if (choice === "pin") openPinDialog(windowId);
}

export function extensionMenu(s: BrowserState, windowId: string | undefined) {
  return windowExtensions(s, windowId).map((x) => ({ id: x.id, title: x.name, icon: x.actionIcon || x.icon, enabled: true }));
}

if (__DEV__) (globalThis as { acExtensionsUi?: unknown }).acExtensionsUi = { useExtensions, confirmInstall, cancelInstall, activateExtension };

export const closePinDialog = () => useExtensions.setState({ pinDialog: null });

export const currentWindowExtensions = (windowId: string) => windowExtensions(useBrowser.getState(), windowId);
