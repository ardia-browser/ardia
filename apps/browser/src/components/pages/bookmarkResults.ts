import type { BookmarkRootIds } from "../../state/bookmarks/bookmarks";
import type { BookmarkNode, Bookmarks } from "../../state/browser/types";
import { queryWords, searchText } from "./PageLayout";

const NO_IDS: readonly string[] = [];
const searchTexts = new WeakMap<BookmarkNode, string>();

function searchTextOf(node: BookmarkNode) {
  let text = searchTexts.get(node);
  if (text === undefined) searchTexts.set(node, (text = searchText(node.title, node.kind === "url" ? node.url : "")));
  return text;
}

export function matchingBookmarks(b: Bookmarks, roots: BookmarkRootIds, query: string): string[] {
  const words = queryWords(query);
  const ids: string[] = [];
  const walk = (folderId: string) => {
    const folder = b.nodes[folderId];
    if (folder?.kind !== "folder") return;
    for (const id of folder.children) {
      const node = b.nodes[id];
      if (!node) continue;
      const text = searchTextOf(node);
      if (words.every((word) => text.includes(word))) ids.push(id);
      if (node.kind === "folder") walk(id);
    }
  };
  walk(roots.bar);
  walk(roots.other);
  return ids;
}

export function listedBookmarks(roots: BookmarkRootIds | null, folderId: string | null, query: string): (b: Bookmarks) => readonly string[] {
  let from: Bookmarks | null = null;
  let listed = NO_IDS;
  return (b) => {
    if (b === from) return listed;
    from = b;
    const folder = folderId ? b.nodes[folderId] : undefined;
    const next = query.trim() && roots ? matchingBookmarks(b, roots, query) : folder?.kind === "folder" ? folder.children : NO_IDS;
    if (next.length !== listed.length || next.some((id, i) => id !== listed[i])) listed = next;
    return listed;
  };
}
