import { bookmarkPages, bookmarksHtml, type BookmarkTree } from "./bookmarksHtml.ts";
import { callHost, type ArdiaHost } from "./host.ts";

export const BOOKMARKS_EXPORT_CALL = "bookmarks.exportHtml";
export const BOOKMARKS_FILE_NAME = "Ardia Bookmarks.html";
const ICON_SIZE = 16;
const ICON_BATCH = 200;
const PNG_DATA_URI = "data:image/png;base64,";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const POLL_MS = 150;
const START_DEADLINE_MS = 120_000;
const FINISH_DEADLINE_MS = 60_000;

type SavedFile = { url?: unknown; state?: unknown; path?: unknown };

export type BookmarksExportPlatform = {
  download(html: string, name: string): { url: string; release(): void };
  wait(ms: number): Promise<void>;
  now(): number;
};

const folder = (value: unknown): value is BookmarkTree["bar"] => !!value && typeof value === "object" && (value as { k?: unknown }).k === "f";

async function bookmarkIcons(host: ArdiaHost, profile: string, pages: string[]): Promise<Record<string, string>> {
  const icons: Record<string, string> = {};
  for (let at = 0; at < pages.length; at += ICON_BATCH) {
    const reply = JSON.parse(await callHost("favicons.get", profile, JSON.stringify({ pages: pages.slice(at, at + ICON_BATCH), icons: [], size: ICON_SIZE }), host)) as { pages?: unknown };
    if (!reply.pages || typeof reply.pages !== "object") continue;
    for (const [page, found] of Object.entries(reply.pages)) {
      const png = (found as { png?: unknown } | null)?.png;
      if (typeof png === "string" && BASE64.test(png)) icons[page] = PNG_DATA_URI + png;
    }
  }
  return icons;
}

async function savedPath(host: ArdiaHost, url: string, platform: BookmarksExportPlatform): Promise<string | null> {
  const started = platform.now();
  let seenAt: number | null = null;
  for (;;) {
    const listed = JSON.parse(await callHost("downloads.list", "", "{}", host)) as unknown;
    const file = Array.isArray(listed) ? (listed as SavedFile[]).find((d) => d?.url === url) : undefined;
    if (file?.state === "finished" && typeof file.path === "string" && file.path) return file.path;
    if (file?.state === "cancelled") return null;
    if (file?.state === "failed") throw Object.assign(new Error("the file couldn't be written"), { code: "ERR_ENGINE" });
    if (file) seenAt ??= platform.now();
    const waited = platform.now() - (seenAt ?? started);
    if (waited > (seenAt === null ? START_DEADLINE_MS : FINISH_DEADLINE_MS)) return null;
    await platform.wait(POLL_MS);
  }
}

export async function exportBookmarksToDownloads(host: ArdiaHost, profile: string, platform: BookmarksExportPlatform): Promise<string | null> {
  const tree = JSON.parse(await callHost("bookmarks.tree", profile, "{}", host)) as Partial<BookmarkTree> | null;
  if (!folder(tree?.bar) || !folder(tree?.other)) throw Object.assign(new Error("no bookmarks"), { code: "ERR_ENGINE" });
  const complete = tree as BookmarkTree;
  const icons = await bookmarkIcons(host, profile, bookmarkPages(complete)).catch(() => ({}));
  const saving = platform.download(bookmarksHtml(complete, icons), BOOKMARKS_FILE_NAME);
  try {
    return await savedPath(host, saving.url, platform);
  } finally {
    saving.release();
  }
}

export const pageDownloads: BookmarksExportPlatform = {
  download(html, name) {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { url, release: () => URL.revokeObjectURL(url) };
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export const bookmarksExportCall = (host: ArdiaHost, platform: BookmarksExportPlatform = pageDownloads) =>
  (profile: string) => exportBookmarksToDownloads(host, profile, platform).then((path) => JSON.stringify(path));
