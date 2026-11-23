import type { BookmarkNode } from "../browser/types";
import { bookmarkRoots, folderChildren, isWithin, ownerOfBookmark } from "../bookmarks/bookmarks";
import type { MethodSpec } from "./socketCatalog";
import { id, ids, int, obj, PAGE, PROFILE, text } from "./socketSchema";
import { expect, now, page, profileArg } from "./socketTargets";
import { openableUrl } from "./workspaceOps";
import { OpError } from "./workspaceTargets";
import { ownValue } from "../../lib/decode";

const MAX_DEPTH = 64;
export const TREE_MAX_ITEMS = 5000;
const TREE_MAX_BYTES = 1024 * 1024;

type TreeBudget = { items: number; bytes: number; truncated: boolean };

const unbounded = (): TreeBudget => ({ items: Infinity, bytes: Infinity, truncated: false });

function spend(budget: TreeBudget, node: BookmarkNode) {
  budget.items -= 1;
  budget.bytes -= 96 + node.title.length * 3 + (node.kind === "url" ? node.url.length * 3 : 0);
  return budget.items >= 0 && budget.bytes >= 0;
}

function bookmarkRow(node: BookmarkNode, depth: number, budget = unbounded()): Record<string, unknown> {
  const b = now().bookmarks;
  const base = { id: node.id, kind: node.kind, parent: node.parentId, title: node.title, addedAt: node.addedAt };
  if (node.kind === "url") return { ...base, url: node.url };
  if (depth <= 0) return { ...base, children: node.children.length };
  const children: Record<string, unknown>[] = [];
  for (const child of folderChildren(b, node.id)) {
    if (!spend(budget, child)) {
      budget.truncated = true;
      return { ...base, children: node.children.length };
    }
    children.push(bookmarkRow(child, depth - 1, budget));
  }
  return { ...base, children };
}

function rootsHolding(profile: string, nodeId: string) {
  const roots = rootsOf(profile);
  if (!isWithin(now().bookmarks, nodeId, [roots.bar, roots.other])) throw new OpError("bad_request", `${nodeId} isn't in profile ${profile}'s bookmarks.`);
}

function rootsOf(profile: string) {
  const roots = bookmarkRoots(now(), profile);
  if (!roots) throw new OpError("failed", `Profile ${profile}'s bookmarks haven't loaded yet; open a window in it first.`);
  return roots;
}

function nodeOf(value: unknown): BookmarkNode {
  const s = now();
  const node = ownValue(s.bookmarks.nodes, value);
  if (!node || !ownerOfBookmark(s, node.id)) throw new OpError("no_window", `There's no bookmark ${String(value)}.`);
  return node;
}

function folderOf(value: unknown) {
  const node = nodeOf(value);
  if (node.kind !== "folder") throw new OpError("bad_request", `${node.id} is a link, not a folder.`);
  return node;
}

function tree(params: Record<string, unknown>) {
  const depth = (params.depth as number | undefined) ?? MAX_DEPTH;
  const budget: TreeBudget = { items: TREE_MAX_ITEMS, bytes: TREE_MAX_BYTES, truncated: false };
  if (params.folder !== undefined) {
    const folder = folderOf(params.folder);
    if (params.profile !== undefined) rootsHolding(profileArg(params.profile), folder.id);
    const row = bookmarkRow(folder, depth, budget);
    return { ...row, truncated: budget.truncated };
  }
  const roots = rootsOf(profileArg(params.profile));
  const b = now().bookmarks;
  const bar = bookmarkRow(b.nodes[roots.bar]!, depth, budget);
  const other = bookmarkRow(b.nodes[roots.other]!, depth, budget);
  return { bar, other, truncated: budget.truncated };
}

function matchesIn(rootIds: readonly string[], q: string) {
  const b = now().bookmarks;
  const hits: BookmarkNode[] = [];
  const seen = new Set<string>();
  const stack = rootIds.flatMap((id) => folderChildren(b, id));
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (!q || n.title.toLowerCase().includes(q) || (n.kind === "url" && n.url.toLowerCase().includes(q))) hits.push(n);
    if (n.kind === "folder") stack.push(...folderChildren(b, n.id));
  }
  return hits;
}

function search(params: Record<string, unknown>) {
  const roots = rootsOf(profileArg(params.profile));
  const q = ((params.query as string | undefined) ?? "").toLowerCase();
  const hits = matchesIn([roots.bar, roots.other], q).sort((x, y) => y.addedAt - x.addedAt);
  return page(hits, params, (n) => bookmarkRow(n, 0));
}

function placeOf(params: Record<string, unknown>) {
  if (params.parent === undefined) return { profileId: profileArg(params.profile), parentId: undefined };
  const parent = folderOf(params.parent);
  if (params.profile !== undefined) {
    const profileId = profileArg(params.profile);
    rootsHolding(profileId, parent.id);
    return { profileId, parentId: parent.id };
  }
  return { profileId: ownerOfBookmark(now(), parent.id)!, parentId: parent.id };
}

function linkUrl(value: unknown): string {
  const url = openableUrl(value as string);
  if (typeof url !== "string" || !url) throw new OpError("refused", typeof url === "string" ? "A bookmark needs a page." : url.error);
  return url;
}

function add(params: Record<string, unknown>) {
  const { profileId, parentId } = placeOf(params);
  const url = linkUrl(params.url);
  const made = now().addBookmark({ profileId, url, title: (params.title as string | undefined) ?? url, parentId, index: params.index as number | undefined });
  expect(!!now().bookmarks.nodes[made], "the bookmark wasn't added.");
  return bookmarkRow(now().bookmarks.nodes[made]!, 0);
}

function addFolder(params: Record<string, unknown>) {
  const { profileId, parentId } = placeOf(params);
  const made = now().addBookmarkFolder({ profileId, title: params.title as string, parentId, index: params.index as number | undefined });
  expect(!!now().bookmarks.nodes[made], "the folder wasn't added.");
  return bookmarkRow(now().bookmarks.nodes[made]!, 0);
}

function update(params: Record<string, unknown>) {
  const node = nodeOf(params.id);
  if (params.url !== undefined && node.kind !== "url") throw new OpError("bad_request", "A folder has no URL.");
  if (params.title === undefined && params.url === undefined) throw new OpError("bad_request", "bookmarks.update needs title or url.");
  now().updateBookmark(node.id, { ...(params.title !== undefined ? { title: params.title as string } : {}), ...(params.url !== undefined ? { url: linkUrl(params.url) } : {}) });
  return bookmarkRow(now().bookmarks.nodes[node.id]!, 0);
}

function move(params: Record<string, unknown>) {
  const parent = folderOf(params.parent);
  const owner = ownerOfBookmark(now(), parent.id);
  const nodes = (params.ids as string[]).map(nodeOf);
  for (const n of nodes) {
    if (ownerOfBookmark(now(), n.id) !== owner) throw new OpError("bad_request", `${n.id} is in another profile's bookmarks.`);
    if (n.kind === "folder" && (n.id === parent.id || isWithin(now().bookmarks, parent.id, [n.id]))) throw new OpError("bad_request", `${n.id} can't go inside itself.`);
    if (n.parentId === null) throw new OpError("refused", `${n.id} is a root folder.`);
  }
  const picked = nodes.map((n) => n.id);
  const carried = nodes.filter((n) => picked.some((other) => other !== n.id && isWithin(now().bookmarks, n.parentId ?? "", [other])));
  now().moveBookmarks(picked, parent.id, params.index as number | undefined);
  const after = now().bookmarks.nodes;
  expect(
    nodes.every((n) => (carried.includes(n) ? after[n.id]?.parentId === n.parentId : after[n.id]?.parentId === parent.id)),
    "the bookmarks didn't move.",
  );
  return bookmarkRow(now().bookmarks.nodes[parent.id]!, 1);
}

function remove(params: Record<string, unknown>) {
  const nodes = (params.ids as string[]).map(nodeOf);
  const root = nodes.find((n) => n.parentId === null);
  if (root) throw new OpError("refused", `${root.id} is a root folder.`);
  now().removeBookmarks(nodes.map((n) => n.id));
  expect(nodes.every((n) => !now().bookmarks.nodes[n.id]), "the bookmarks weren't removed.");
  return { removed: nodes.length };
}

const BOOKMARK_PLACE = { profile: PROFILE, parent: id("A folder id; the profile's Bookmarks Bar when left out"), index: int("Position in the folder; the end when left out", 0) };

export const LIBRARY_METHODS: MethodSpec[] = [
  { name: "bookmarks.tree", mutates: false, description: "A profile's Bookmarks Bar and Other Bookmarks, or one folder, as a tree", params: obj({ profile: PROFILE, folder: id("Only this folder"), depth: int("How many folder levels to open (all when left out)", 0, MAX_DEPTH) }), result: "{bar, other, truncated} | {…folder, truncated}", run: tree },
  { name: "bookmarks.search", mutates: false, description: "Bookmarks and folders whose title or URL contains the query, newest first", params: obj({ profile: PROFILE, query: text("Text to look for; every bookmark when left out"), ...PAGE }), result: "{items, total, nextOffset}", run: search },
  { name: "bookmarks.get", mutates: false, description: "One bookmark or folder", params: obj({ id: id("A bookmark id") }, ["id"]), result: "bookmark", run: (p) => bookmarkRow(nodeOf(p.id), 1) },
  { name: "bookmarks.add", mutates: true, description: "Bookmark a page", params: obj({ url: text("The page"), title: text("Its title; the URL when left out"), ...BOOKMARK_PLACE }, ["url"]), result: "bookmark", run: add },
  { name: "bookmarks.addFolder", mutates: true, description: "Make a bookmarks folder", params: obj({ title: text("Its name"), ...BOOKMARK_PLACE }, ["title"]), result: "folder", run: addFolder },
  { name: "bookmarks.update", mutates: true, description: "Rename a bookmark or folder, or change a bookmark's URL", params: obj({ id: id("A bookmark id"), title: text("New title"), url: text("New URL") }, ["id"]), result: "bookmark", run: update },
  { name: "bookmarks.move", mutates: true, description: "Move bookmarks and folders into a folder", params: obj({ ids: ids("Bookmark ids, in the order they should land"), parent: id("The folder"), index: int("Position in the folder; the end when left out", 0) }, ["ids", "parent"]), result: "folder", run: move },
  { name: "bookmarks.remove", mutates: true, description: "Delete bookmarks and folders (with what's in them)", params: obj({ ids: ids("Bookmark ids") }, ["ids"]), result: "{removed}", run: remove },
];
