import type { Download, DownloadSettings } from "../../downloads";
import type { Profile } from "../wire";

export type DownloadsCalls = {
  "downloads.cancel": [{ id: string }, null];
  "downloads.pause": [{ id: string }, null];
  "downloads.resume": [{ id: string }, null];
  "downloads.keep": [{ id: string }, null];
  "downloads.settings": [Profile, DownloadSettings];
  "downloads.setSettings": [Profile & Partial<Pick<DownloadSettings, "folder" | "askWhereToSave">>, DownloadSettings];
};

export type DownloadsEvents = {
  "downloads.changed": Download;
};
