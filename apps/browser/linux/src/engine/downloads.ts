import { app, type DownloadItem, type WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { dataDirectory } from "../paths";
import { defineDomain, emitDomainEvent } from "./domains";
import { guestOf, tell, windowOf } from "./guests";
import { isPrivateProfile } from "./partitions";
import { onPageSession } from "./sessions";

type DownloadSettings = { folder: string; askWhereToSave: boolean; managed: boolean };
type Tracked = { id: string; item: DownloadItem; profile: string; lastBytes: number; lastAt: number; speed: number; kept: boolean };

const SETTINGS_FILE = "downloads.json";
const SPEED_WINDOW_MS = 1000;

const downloads = new Map<string, Tracked>();
let nextId = 0;

const settingsPath = () => join(dataDirectory(), "Engine", SETTINGS_FILE);

function readSettings(): Record<string, Partial<DownloadSettings>> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, Partial<DownloadSettings>>;
  } catch {
    return {};
  }
}

const defaultFolder = () => (process.env.ARDIA_DATA_DIR ? join(dataDirectory(), "Downloads") : app.getPath("downloads"));

function settingsOf(profile: string): DownloadSettings {
  const saved = readSettings()[profile] ?? {};
  return { folder: saved.folder || defaultFolder(), askWhereToSave: saved.askWhereToSave === true, managed: false };
}

export const downloadFolderOf = (profile: string): string => settingsOf(profile).folder;

function saveSettings(profile: string, change: Partial<DownloadSettings>): DownloadSettings {
  const all = readSettings();
  all[profile] = { ...all[profile], ...change };
  mkdirSync(join(dataDirectory(), "Engine"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(all, null, 2));
  return settingsOf(profile);
}

function freePath(folder: string, filename: string): string {
  const extension = extname(filename);
  const stem = basename(filename, extension) || "download";
  let candidate = join(folder, `${stem}${extension}`);
  for (let copy = 1; existsSync(candidate) || [...downloads.values()].some((d) => d.item.getSavePath() === candidate); copy++) candidate = join(folder, `${stem} (${copy})${extension}`);
  return candidate;
}

function stateOf(item: DownloadItem): "downloading" | "finished" | "failed" | "cancelled" {
  const state = item.getState();
  if (state === "completed") return "finished";
  if (state === "cancelled") return "cancelled";
  if (state === "interrupted") return item.canResume() ? "downloading" : "failed";
  return "downloading";
}

function shaped(tracked: Tracked) {
  const { item } = tracked;
  const path = item.getSavePath();
  return {
    id: tracked.id,
    url: item.getURL(),
    filename: path ? basename(path) : item.getFilename(),
    path,
    state: stateOf(item),
    paused: item.isPaused(),
    received: item.getReceivedBytes(),
    total: Math.max(0, item.getTotalBytes()),
    speed: tracked.speed,
    mimeType: item.getMimeType(),
    profile: tracked.profile,
    offTheRecord: isPrivateProfile(tracked.profile),
    startTime: Math.round(item.getStartTime() * 1000),
  };
}

const announce = (tracked: Tracked) => emitDomainEvent("downloads.changed", shaped(tracked));

function measure(tracked: Tracked) {
  const now = Date.now();
  const elapsed = now - tracked.lastAt;
  if (elapsed < SPEED_WINDOW_MS) return;
  const bytes = tracked.item.getReceivedBytes();
  tracked.speed = Math.max(0, Math.round(((bytes - tracked.lastBytes) * 1000) / elapsed));
  tracked.lastBytes = bytes;
  tracked.lastAt = now;
}

function noteNavigation(contents: WebContents | undefined, item: DownloadItem) {
  const guest = guestOf(contents);
  if (!guest) return;
  const pageUrl = guest.committedUrl;
  if (item.getURL() === guest.url || !pageUrl || pageUrl === "about:blank") tell(guest, "downloadNavigation", { url: item.getURL(), committedUrl: pageUrl, skipped: false });
}

function track(item: DownloadItem, contents: WebContents | undefined, profile: string) {
  const id = `linux-${process.pid}-${++nextId}`;
  const tracked: Tracked = { id, item, profile, lastBytes: 0, lastAt: Date.now(), speed: 0, kept: false };
  downloads.set(id, tracked);
  const settings = settingsOf(profile);
  const guest = guestOf(contents);
  if (settings.askWhereToSave) {
    const window = guest ? windowOf(guest) : null;
    item.setSaveDialogOptions({ defaultPath: join(settings.folder, item.getFilename()) });
    if (!window) item.setSavePath(freePath(settings.folder, item.getFilename()));
  } else {
    mkdirSync(settings.folder, { recursive: true });
    item.setSavePath(freePath(settings.folder, item.getFilename()));
  }
  noteNavigation(contents, item);
  item.on("updated", () => {
    measure(tracked);
    announce(tracked);
  });
  item.once("done", () => {
    tracked.speed = 0;
    announce(tracked);
  });
  announce(tracked);
}

onPageSession((session, profile) => {
  session.on("will-download", (_event, item, contents) => track(item, contents, profile));
});

const withDownload = (args: Record<string, unknown>, run: (tracked: Tracked) => void) => {
  const tracked = downloads.get(typeof args.id === "string" ? args.id : "");
  if (tracked) run(tracked);
  return null;
};

defineDomain("downloads", {
  cancel: (args) => withDownload(args, (d) => d.item.cancel()),
  pause: (args) =>
    withDownload(args, (d) => {
      d.item.pause();
      announce(d);
    }),
  resume: (args) =>
    withDownload(args, (d) => {
      if (d.item.canResume()) d.item.resume();
      announce(d);
    }),
  keep: (args) =>
    withDownload(args, (d) => {
      d.kept = true;
      announce(d);
    }),
  settings: (_args, profile) => settingsOf(profile),
  setSettings: async (args, profile) => {
    const change: Partial<DownloadSettings> = {};
    if (typeof args.folder === "string") change.folder = args.folder;
    if (typeof args.askWhereToSave === "boolean") change.askWhereToSave = args.askWhereToSave;
    return saveSettings(profile, change);
  },
});
