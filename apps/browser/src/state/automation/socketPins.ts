import { useBrowser, type BrowserState } from "../browser/store";
import { pinSection } from "../browser/model";
import { addToTileFolder, dissolveTileFolder, folderIn, folderLabel, folderMembers, leaveTileFolder, newTileFolder, renameTileFolder, tileFolderOf } from "../pins/tileFolders";
import { eligibleKind } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { id, ids, obj, text, WINDOW } from "./socketSchema";
import { expect, now, tabOf, windowOrFocused } from "./socketTargets";
import { guardEmptied, noSplitTiles } from "./workspaceChecks";
import { refuseSharedTabs } from "./workspaceSharedGuard";
import { OpError } from "./workspaceTargets";

const MAX_NAME = 200;

function folderRow(s: BrowserState, windowId: string, folderId: string) {
  const folder = folderIn(s, windowId, folderId);
  return { id: folderId, window: windowId, profile: s.windows[windowId]!.profileId, name: folder?.name ?? "", label: folderLabel(folder), tabs: folderMembers(s, windowId, folderId) };
}

function foldersIn(s: BrowserState, windowId: string) {
  const seen = new Set<string>();
  const profileId = s.windows[windowId]!.profileId;
  for (const tabId of s.windows[windowId]!.tabIds) {
    const t = s.tabs[tabId];
    const folder = t?.profileId === profileId ? tileFolderOf(t) : undefined;
    if (folder) seen.add(folder.id);
  }
  return [...seen].map((folderId) => folderRow(s, windowId, folderId));
}

function folderOf(params: Record<string, unknown>, near?: string): { windowId: string; folderId: string } {
  const s = now();
  const folderId = params.folder as string;
  const order = [...(near ? [near] : []), ...s.ui.focusOrder, ...s.windowOrder];
  const windows = params.window !== undefined ? [windowOrFocused(params.window).id] : [...new Set(order)].filter((w) => eligibleKind(s, w) === "normal");
  const windowId = windows.find((w) => folderMembers(s, w, folderId).length > 0);
  if (!windowId) throw new OpError("no_window", `There's no tile folder ${folderId}${params.window !== undefined ? ` in window ${String(params.window)}` : ""}.`);
  return { windowId, folderId };
}

function nameOf(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (value !== undefined && name.length > MAX_NAME) throw new OpError("bad_request", `name is at most ${MAX_NAME} characters.`);
  return name;
}

function sameSpace(tabIds: string[]) {
  const tabs = [...new Set(tabIds)].map(tabOf);
  const first = tabs[0]!;
  if (eligibleKind(now(), first.windowId) !== "normal") throw new OpError("bad_request", "Tile folders are in a main window's sidebar, not in Little Ardia.");
  if (tabs.some((t) => t.windowId !== first.windowId || t.profileId !== first.profileId)) throw new OpError("bad_request", "Every tab must be in the same window and profile.");
  if (now().windows[first.windowId]!.profileId !== first.profileId) throw new OpError("bad_request", "Those tabs belong to a profile the window isn't showing.");
  return tabs.map((t) => t.id);
}

function intoFolderChecks(tabIds: string[]) {
  const s = now();
  noSplitTiles(s, tabIds, { pinned: true, row: false }, "into a tile folder");
  refuseSharedTabs(tabIds);
  guardEmptied(s, new Set(tabIds));
}

function createFolder(params: Record<string, unknown>) {
  const tabIds = sameSpace(params.tabs as string[]);
  intoFolderChecks(tabIds);
  const { state, folderId } = newTileFolder(now(), tabIds, nameOf(params.name));
  expect(!!folderId, "the folder wasn't made.");
  useBrowser.setState(state);
  const windowId = now().tabs[tabIds[0]!]!.windowId;
  expect(folderMembers(now(), windowId, folderId!).length > 0, "the folder wasn't made.");
  return folderRow(now(), windowId, folderId!);
}

function renameFolder(params: Record<string, unknown>) {
  const { windowId, folderId } = folderOf(params);
  useBrowser.setState((s) => renameTileFolder(s, windowId, folderId, nameOf(params.name)));
  return folderRow(now(), windowId, folderId);
}

function removeFolder(params: Record<string, unknown>) {
  const { windowId, folderId } = folderOf(params);
  const tabs = folderMembers(now(), windowId, folderId);
  useBrowser.setState((s) => dissolveTileFolder(s, windowId, folderId));
  expect(folderMembers(now(), windowId, folderId).length === 0, "the folder is still there.");
  return { ok: true, tabs };
}

function addTabs(params: Record<string, unknown>) {
  const { windowId, folderId } = folderOf(params, tabOf((params.tabs as string[])[0]).windowId);
  const onto = folderMembers(now(), windowId, folderId)[0]!;
  const moving = sameSpace([onto, ...(params.tabs as string[])]).filter((t) => t !== onto);
  if (moving.some((t) => now().tabs[t]!.windowId !== windowId)) throw new OpError("bad_request", "Those tabs aren't in the folder's window.");
  expect(pinSection(now().tabs[onto]) === "tile", "the folder's tabs aren't tiles.");
  intoFolderChecks(moving);
  useBrowser.setState((s) => addToTileFolder(s, moving, onto));
  expect(moving.every((t) => tileFolderOf(now().tabs[t])?.id === folderId), "not every tab went into the folder.");
  return folderRow(now(), windowId, folderId);
}

function removeTabs(params: Record<string, unknown>) {
  const tabIds = [...new Set(params.tabs as string[])].map((t) => tabOf(t).id);
  const outside = tabIds.filter((t) => !tileFolderOf(now().tabs[t]));
  if (outside.length) throw new OpError("bad_request", `${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} in a tile folder.`);
  for (const tabId of tabIds) if (tileFolderOf(now().tabs[tabId])) useBrowser.setState((s) => leaveTileFolder(s, [tabId]));
  expect(tabIds.every((t) => !tileFolderOf(now().tabs[t])), "a tab is still in its folder.");
  return { ok: true };
}

const FOLDER = id("A tile folder id from pins.folders");
const FOLDER_WINDOW = { ...WINDOW, description: "The window the folder is in; any window when left out" };
const ROW = "{id, window, profile, name, label, tabs}";

export const PIN_METHODS: MethodSpec[] = [
  { name: "pins.folders", mutates: false, description: "The tile folders among a window's Top Apps, with their tabs", params: obj({ window: { ...WINDOW, description: "A window id from windows; the focused one when left out" } }), result: `[${ROW}]`, run: (p) => foldersIn(now(), windowOrFocused(p.window).id) },
  {
    name: "pins.createFolder",
    mutates: true,
    description: "Make a tile folder of tabs in one window, pinning them as tiles",
    params: obj({ tabs: ids("Tab ids from one window", 100), name: text("The folder's name; none when left out") }, ["tabs"]),
    result: ROW,
    run: createFolder,
  },
  { name: "pins.renameFolder", mutates: true, description: "Rename a tile folder", params: obj({ folder: FOLDER, window: FOLDER_WINDOW, name: text("The new name; empty for none") }, ["folder", "name"]), result: ROW, run: renameFolder },
  { name: "pins.removeFolder", mutates: true, description: "Remove a tile folder; its tabs stay pinned as tiles", params: obj({ folder: FOLDER, window: FOLDER_WINDOW }, ["folder"]), result: "{ok, tabs}", run: removeFolder },
  { name: "pins.addToFolder", mutates: true, description: "Put tabs from the folder's window into a tile folder, pinning them", params: obj({ folder: FOLDER, window: FOLDER_WINDOW, tabs: ids("Tab ids", 100) }, ["folder", "tabs"]), result: ROW, run: addTabs },
  { name: "pins.removeFromFolder", mutates: true, description: "Take tabs out of their tile folder; they stay pinned as tiles", params: obj({ tabs: ids("Tab ids in a tile folder", 100) }, ["tabs"]), result: "{ok}", run: removeTabs },
];
