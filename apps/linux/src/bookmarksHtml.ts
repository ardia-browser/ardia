import type { EngineBookmark } from "../../../packages/ardiacore/src/bookmarks";

export type BookmarkTree = { bar: EngineBookmark; other: EngineBookmark };

const NEWLINE = "\r\n";
const INDENT = "    ";
const HEADER = [
  "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
  "<!-- This is an automatically generated file.",
  "     It will be read and overwritten.",
  "     DO NOT EDIT! -->",
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  "<TITLE>Bookmarks</TITLE>",
  "<H1>Bookmarks</H1>",
  "<DL><p>",
].join(NEWLINE) + NEWLINE;

const CONTENT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const content = (text: string) => text.replace(/[&<>"']/g, (c) => CONTENT_ESCAPES[c]!);
const attribute = (text: string) => text.replaceAll('"', "&quot;");
const seconds = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0);
const children = (node: EngineBookmark) => (Array.isArray(node.c) ? node.c : []);
const lastModified = (folder: EngineBookmark) => children(folder).reduce((latest, child) => Math.max(latest, seconds(child.a)), 0);

export const bookmarkPages = (tree: BookmarkTree): string[] => {
  const pages = new Set<string>();
  const walk = (node: EngineBookmark) => {
    if (node.k === "u") {
      if (typeof node.u === "string") pages.add(node.u);
    } else children(node).forEach(walk);
  };
  walk(tree.bar);
  walk(tree.other);
  return [...pages];
};

export function bookmarksHtml(tree: BookmarkTree, icons: Readonly<Record<string, string>> = {}): string {
  const lines: string[] = [];
  const folderStart = (folder: EngineBookmark, depth: number, bar: boolean) => {
    const pad = INDENT.repeat(depth);
    lines.push(`${pad}<DT><H3 ADD_DATE="${seconds(folder.a)}" LAST_MODIFIED="${lastModified(folder)}"${bar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ""}>${content(folder.t ?? "")}</H3>`, `${pad}<DL><p>`);
  };
  const folderEnd = (depth: number) => lines.push(`${INDENT.repeat(depth)}</DL><p>`);
  const write = (node: EngineBookmark, depth: number) => {
    if (node.k === "u") {
      if (typeof node.u !== "string") return;
      const icon = Object.hasOwn(icons, node.u) ? icons[node.u] : undefined;
      lines.push(`${INDENT.repeat(depth)}<DT><A HREF="${attribute(node.u)}" ADD_DATE="${seconds(node.a)}"${icon ? ` ICON="${attribute(icon)}"` : ""}>${content(node.t ?? "")}</A>`);
      return;
    }
    folderStart(node, depth, false);
    for (const child of children(node)) write(child, depth + 1);
    folderEnd(depth);
  };
  folderStart(tree.bar, 1, true);
  for (const child of children(tree.bar)) write(child, 2);
  folderEnd(1);
  for (const child of children(tree.other)) write(child, 1);
  lines.push("</DL><p>");
  return HEADER + lines.join(NEWLINE) + NEWLINE;
}
