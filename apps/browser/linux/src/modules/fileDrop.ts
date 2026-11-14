import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { defineModule } from "../bridge";

type Accepts = "links" | "linksAndText" | "extensionPackages";
type DroppedItem = { kind: "file"; url: string } | { kind: "url"; url: string };

const MAX_ITEMS = 50;
const MAX_LINK_FILE_BYTES = 64 * 1024;
const LINK_FILE_EXTENSIONS = new Set([".webloc", ".inetloc", ".url"]);

export function webUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length >= 8192) return null;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

const sizeOf = (path: string): number | null => {
  try {
    const stat = statSync(path);
    return stat.isFile() || stat.isDirectory() ? stat.size : null;
  } catch {
    return null;
  }
};

export function linkTarget(path: string, read: (path: string) => string = (file) => readFileSync(file, "latin1")): string | null {
  const size = sizeOf(path);
  if (size === null || size > MAX_LINK_FILE_BYTES) return null;
  let text: string;
  try {
    text = read(path);
  } catch {
    return null;
  }
  if (extname(path).toLowerCase() === ".url") {
    for (const line of text.split(/\r?\n/)) if (line.toLowerCase().startsWith("url=")) return webUrl(line.slice(4));
    return null;
  }
  const match = /<key>\s*URL\s*<\/key>\s*<string>([^<]*)<\/string>/i.exec(text);
  return match ? webUrl(match[1]!.replace(/&amp;/g, "&")) : null;
}

export function droppedFiles(paths: string[], accepts: Accepts): DroppedItem[] {
  const files = paths.filter((path) => typeof path === "string" && isAbsolute(path));
  if (accepts === "extensionPackages") {
    if (!files.length || files.length > MAX_ITEMS) return [];
    const packages = files.every((path) => extname(path).toLowerCase() === ".crx" && sizeOf(path) !== null);
    return packages ? files.map((path) => ({ kind: "file", url: pathToFileURL(path).href })) : [];
  }
  const items: DroppedItem[] = [];
  for (const path of files.slice(0, MAX_ITEMS)) {
    if (LINK_FILE_EXTENSIONS.has(extname(path).toLowerCase())) {
      const url = linkTarget(path);
      if (url) items.push({ kind: "url", url });
    } else if (sizeOf(path) !== null) items.push({ kind: "file", url: pathToFileURL(path).href });
  }
  return items;
}

defineModule("ArdiaLinuxFileDrop", {
  sync: { droppedFiles: (paths: string[], accepts: Accepts) => droppedFiles(Array.isArray(paths) ? paths : [], accepts) },
});
