import { TAB_GROUP_COLORS } from "@ardia/core";
import { isIncognitoProfile } from "../browser/model";
import type { GroupColor } from "../browser/types";
import { connectedSourcesOf, deleteLiveFolder, manualRefresh, newProfileLiveFolder, openLiveItem, refreshFolderWhile } from "../live/engine";
import { hideItems, live, markRead, setRepoHidden, unhide, updateFolder } from "../live/store";
import type { CompletedItem, LiveFolder, LiveFolderKind, LiveItem, LiveSourceId } from "../live/types";
import { ownEntry } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, ids, obj, oneOf, PAGE, PROFILE, text, WINDOW } from "./socketSchema";
import { PAGE_BYTE_BUDGET } from "./socketWire";
import { expect, now, page, profileArg, windowOrFocused } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { programControlOn } from "../app/programControlSetting";

const KINDS = ["pullRequests", "documents"] as const satisfies readonly LiveFolderKind[];
const SOURCES_OF: Record<LiveFolderKind, readonly LiveSourceId[]> = { pullRequests: ["github", "bitbucket"], documents: ["notion", "confluence", "gdrive"] };
const ALL_SOURCES = [...SOURCES_OF.pullRequests, ...SOURCES_OF.documents];
const COLORS = ["none", ...TAB_GROUP_COLORS] as const;
const MAX_NAME = 200;

function folderOf(folderId: unknown): LiveFolder {
  const folder = ownEntry(live().folders, folderId);
  if (!folder || isIncognitoProfile(folder.profileId)) throw new OpError("no_window", `There's no live folder ${String(folderId)}.`);
  return folder;
}

function folderRow(folder: LiveFolder) {
  const l = live();
  return {
    id: folder.id,
    profile: folder.profileId,
    kind: folder.kind,
    name: folder.name,
    icon: folder.icon,
    color: folder.color ?? null,
    collapsed: folder.collapsed,
    sources: folder.sources,
    filters: folder.filters,
    groupStacks: folder.groupStacks,
    showCompleted: folder.showCompleted,
    hiddenRepos: folder.hiddenRepos,
    showNewRepos: folder.showNewRepos,
    status: l.status[folder.id] ?? { state: "idle", lastFetch: null, error: null },
    items: (l.items[folder.id] ?? []).length,
    unread: (l.unread[folder.id] ?? []).length,
    hidden: (l.hidden[folder.id] ?? []).length,
    createdAt: folder.createdAt,
  };
}

function list(params: Record<string, unknown>) {
  const profile = params.profile !== undefined ? profileArg(params.profile) : null;
  const l = live();
  const folders = l.folderOrder.flatMap((f) => {
    const folder = l.folders[f];
    return folder && !isIncognitoProfile(folder.profileId) && (!profile || folder.profileId === profile) ? [folderRow(folder)] : [];
  });
  const accounts = Object.fromEntries(Object.entries(l.accounts).flatMap(([source, a]) => (a ? [[source, { login: a.login, name: a.name, connectedAt: a.connectedAt }]] : [])));
  return { folders, accounts };
}

type Entry = { shown: "listed" | "hidden"; item: LiveItem } | { shown: "completed"; done: CompletedItem };

const itemOf = (entry: Entry) => (entry.shown === "completed" ? entry.done.item : entry.item);
const utf8 = new TextEncoder();
const MAX_ITEM_BYTES = PAGE_BYTE_BUDGET / 2;
const sendable = (item: LiveItem) => (utf8.encode(JSON.stringify(item)).length <= MAX_ITEM_BYTES ? item : { id: item.id, source: item.source, oversized: true });

function items(params: Record<string, unknown>) {
  const folder = folderOf(params.folder);
  const l = live();
  const done = l.completed[folder.id] ?? [];
  const completedIds = new Set(done.map((c) => c.item.id));
  const seen = new Set<string>();
  const entries: Entry[] = [
    ...(l.items[folder.id] ?? []).filter((item) => !completedIds.has(item.id)).map((item) => ({ shown: "listed" as const, item })),
    ...(l.hidden[folder.id] ?? []).filter((item) => !completedIds.has(item.id)).map((item) => ({ shown: "hidden" as const, item })),
    ...done.map((c) => ({ shown: "completed" as const, done: c })),
  ].filter((entry) => {
    const id = itemOf(entry).id;
    return !seen.has(id) && !!seen.add(id);
  });
  const unread = new Set(l.unread[folder.id] ?? []);
  return page(entries, params, (entry) => {
    const item = itemOf(entry);
    return { item: sendable(item), shown: entry.shown, unread: unread.has(item.id), completed: entry.shown === "completed" ? { state: entry.done.state, at: entry.done.at } : null };
  });
}

function sourcesFor(kind: LiveFolderKind, given: unknown): LiveSourceId[] {
  if (given === undefined) {
    const connected = connectedSourcesOf(kind);
    if (!connected.length) throw new OpError("refused", `No ${SOURCES_OF[kind].join(" or ")} account is connected; connect one in Settings › Automations first.`);
    return connected;
  }
  const sources = [...new Set(given as LiveSourceId[])];
  const wrong = sources.filter((s) => !SOURCES_OF[kind].includes(s));
  if (wrong.length) throw new OpError("bad_request", `A ${kind} folder takes ${SOURCES_OF[kind].join(", ")}, not ${wrong.join(", ")}.`);
  const off = sources.filter((s) => !live().accounts[s]);
  if (off.length) throw new OpError("refused", `${off.join(", ")} ${off.length === 1 ? "isn't" : "aren't"} connected; connect in Settings › Automations first.`);
  return sources;
}

function create(params: Record<string, unknown>) {
  const profile = profileArg(params.profile);
  const kind = params.kind as LiveFolderKind;
  const name = params.name !== undefined ? nameOf(params.name) : undefined;
  const sources = sourcesFor(kind, params.sources);
  const folderId = newProfileLiveFolder(profile, kind, sources, { name, allowed: controlStillOn });
  expect(!!live().folders[folderId], "the live folder wasn't made.");
  return folderRow(live().folders[folderId]!);
}

const controlStillOn = () => programControlOn(now());

function nameOf(value: unknown): string {
  const name = (value as string).trim();
  if (!name || name.length > MAX_NAME) throw new OpError("bad_request", `name is 1 to ${MAX_NAME} characters.`);
  return name;
}

const PATCHABLE = ["collapsed", "groupStacks", "showCompleted", "icon"] as const;

function update(params: Record<string, unknown>, call: SocketCall) {
  const folder = folderOf(params.folder);
  const patch: Partial<LiveFolder> = {};
  for (const key of PATCHABLE) if (params[key] !== undefined) Object.assign(patch, { [key]: params[key] });
  if (params.name !== undefined) patch.name = nameOf(params.name);
  if (params.color !== undefined) patch.color = params.color as GroupColor | null;
  if (params.filters !== undefined) patch.filters = { ...folder.filters, ...(params.filters as Partial<LiveFolder["filters"]>) };
  if (params.sources !== undefined) patch.sources = sourcesFor(folder.kind, params.sources);
  if (!Object.keys(patch).length) throw new OpError("bad_request", "live.update needs something to change.");
  updateFolder(folder.id, patch);
  if (patch.filters || patch.sources) void refreshFolderWhile(folder.id, false, controlStillOn);
  return folderRow(live().folders[folder.id]!);
}

async function refresh(params: Record<string, unknown>, call: SocketCall) {
  const folder = folderOf(params.folder);
  await manualRefresh(folder.id, call.serving);
  if (!call.serving()) throw new OpError("failed", "Control was turned off during the refresh. The folder's hidden items were already shown again; nothing else changed.");
  return folderRow(live().folders[folder.id] ?? folder);
}

function hide(params: Record<string, unknown>) {
  const folder = folderOf(params.folder);
  const wanted = new Set(params.items as string[]);
  const hiding = (live().items[folder.id] ?? []).filter((it) => wanted.has(it.id));
  const missing = [...wanted].filter((w) => !hiding.some((it) => it.id === w));
  if (missing.length) throw new OpError("no_window", `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} shown in that folder.`);
  hideItems(folder.id, hiding);
  return folderRow(live().folders[folder.id]!);
}

function setRepo(params: Record<string, unknown>, call: SocketCall) {
  const folder = folderOf(params.folder);
  if (folder.kind !== "pullRequests") throw new OpError("bad_request", "Only pull request folders filter by repository.");
  if (!/^[a-z]+:[^\s]+$/.test(params.repo as string)) throw new OpError("bad_request", "repo is source:owner/name, like github:ardia-browser/ardia.");
  setRepoHidden(folder.id, params.repo as string, params.hidden as boolean);
  if (!params.hidden) void refreshFolderWhile(folder.id, false, call.serving);
  return folderRow(live().folders[folder.id]!);
}

function open(params: Record<string, unknown>) {
  const folder = folderOf(params.folder);
  const l = live();
  const item = [...(l.items[folder.id] ?? []), ...(l.hidden[folder.id] ?? []), ...(l.completed[folder.id] ?? []).map((c) => c.item)].find((it) => it.id === params.item);
  if (!item) throw new OpError("no_window", `There's no item ${String(params.item)} in that folder.`);
  const w = windowOrFocused(params.window);
  if (w.profileId !== folder.profileId) throw new OpError("bad_request", "That window shows another profile than the folder's.");
  const tab = openLiveItem(w.id, folder.id, item, { background: params.background === true });
  expect(!!now().tabs[tab], "the tab didn't open.");
  return { tab, window: w.id };
}

const FOLDER = id("A live folder id from live.list");
const ROW = "{id, profile, kind, name, sources, filters, status, items, unread, hidden, …}";
const withFolder = (run: (folderId: string) => void) => (params: Record<string, unknown>) => {
  const folder = folderOf(params.folder);
  run(folder.id);
  return folderRow(live().folders[folder.id]!);
};

export const LIVE_METHODS: MethodSpec[] = [
  { name: "live.list", mutates: false, description: "Live folders (pull requests, documents) with their status and counts, and the connected accounts", params: obj({ profile: { ...PROFILE, description: "Only this profile's folders; every profile's when left out" } }), result: `{folders: [${ROW}], accounts}`, run: list },
  {
    name: "live.items",
    mutates: false,
    description: "A live folder's items, a page at a time: listed, then hidden, then recently completed, each with whether it's unread",
    params: obj({ folder: FOLDER, ...PAGE }, ["folder"]),
    result: "{items: [{item, shown, unread, completed}], total, nextOffset}",
    run: items,
  },
  {
    name: "live.create",
    mutates: true,
    description: "Make a live folder in a profile's sidebar; it fetches at once",
    params: obj({ profile: PROFILE, kind: oneOf(KINDS, "pullRequests or documents"), sources: { type: "array", items: oneOf(ALL_SOURCES, "A connected source"), minItems: 1, maxItems: 3, description: "Connected sources; all connected ones of its kind when left out, refused when none is" }, name: text("Its name") }, ["kind"]),
    result: ROW,
    run: create,
  },
  {
    name: "live.update",
    mutates: true,
    description: "Rename a live folder or change its icon, colour, sources, filters and options",
    params: obj({
      folder: FOLDER,
      name: text("Its name"),
      icon: { type: ["string", "null"], description: "An SF Symbol name or emoji; null for the default" },
      color: { type: ["string", "null"], enum: [...COLORS, null], description: "Its colour; null for the default" },
      collapsed: bool("Folded in the sidebar"),
      sources: { type: "array", items: oneOf(ALL_SOURCES, "A connected source"), minItems: 1, maxItems: 3, description: "Connected sources of its kind" },
      filters: obj({ authored: bool("Pull requests you opened"), reviewRequests: bool("Reviews asked of you") }),
      groupStacks: bool("Group stacked pull requests"),
      showCompleted: bool("Show merged, closed and reviewed items for a while"),
    }, ["folder"]),
    result: ROW,
    run: update,
  },
  { name: "live.remove", mutates: true, description: "Delete a live folder and close the tabs opened from it", params: obj({ folder: FOLDER }, ["folder"]), result: "{ok}", run: (p) => (deleteLiveFolder(folderOf(p.folder).id), { ok: true }) },
  { name: "live.refresh", mutates: true, description: "Fetch a live folder now, bringing back the items hidden in it", params: obj({ folder: FOLDER }, ["folder"]), result: ROW, run: refresh },
  { name: "live.hide", mutates: true, description: "Hide items from a live folder until it's refreshed by hand", params: obj({ folder: FOLDER, items: ids("Item ids from live.items", 200) }, ["folder", "items"]), result: ROW, run: hide },
  { name: "live.unhide", mutates: true, description: "Show a live folder's hidden items again", params: obj({ folder: FOLDER }, ["folder"]), result: ROW, run: withFolder(unhide) },
  {
    name: "live.markRead",
    mutates: true,
    description: "Mark a live folder's items read; all of them when items is left out",
    params: obj({ folder: FOLDER, items: ids("Item ids from live.items", 200) }, ["folder"]),
    result: ROW,
    run: (p) => withFolder((f) => markRead(f, p.items as string[] | undefined))(p),
  },
  { name: "live.setRepoHidden", mutates: true, description: "Hide or show a repository's pull requests in a folder", params: obj({ folder: FOLDER, repo: text("source:owner/name, like github:ardia-browser/ardia"), hidden: bool("Hidden") }, ["folder", "repo", "hidden"]), result: ROW, run: setRepo },
  {
    name: "live.open",
    mutates: true,
    description: "Open a live folder's item as a tab in a window showing its profile",
    params: obj({ folder: FOLDER, item: id("An item id from live.items"), window: { ...WINDOW, description: "A window id from windows; the focused one when left out" }, background: bool("Open without switching to it") }, ["folder", "item"]),
    result: "{tab, window}",
    run: open,
  },
];
