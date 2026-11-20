import { useEffect, useMemo, useState } from "react";
import { getDownloadSettings, onDownloadSettingsChange } from "../../platform/downloads";
import { listFolderMedia, watchFolder, type FolderMediaFile, type FolderMediaListing, type FolderMediaStatus } from "../../platform/files";
import { consentToken } from "../telemetry/client";
import { noteLibraryFolderListing } from "../telemetry/libraryCounts";

export const FOLDER_MEDIA_LIMIT = 500;

export type { FolderMediaStatus };
export type FolderListing = { folder: string; engines: readonly string[]; status: FolderMediaStatus; files: readonly FolderMediaFile[] };

type Listed = { status: FolderMediaStatus; files: readonly FolderMediaFile[] };

const NO_FILES: readonly FolderMediaFile[] = [];
const NO_LISTINGS: readonly FolderListing[] = [];
const NOT_LISTED: Listed = { status: "ok", files: NO_FILES };
const UNAVAILABLE: FolderMediaListing = { status: "unavailable", files: [] };
const MEDIA_KINDS = new Set(["image", "video", "audio"]);
const lastListing = new Map<string, Listed>();
const lastFolder = new Map<string, string>();

const validFile = (file: FolderMediaFile | null | undefined): file is FolderMediaFile =>
  !!file && typeof file.path === "string" && file.path.startsWith("/") && typeof file.name === "string" && MEDIA_KINDS.has(file.kind) && Number.isFinite(file.added);

const sameFiles = (a: readonly FolderMediaFile[], b: readonly FolderMediaFile[]) =>
  a.length === b.length && a.every((file, i) => file.path === b[i]!.path && file.added === b[i]!.added && file.kind === b[i]!.kind && file.name === b[i]!.name);

export function folderListings(engines: readonly string[]): readonly FolderListing[] {
  const byFolder = new Map<string, string[]>();
  for (const engine of engines) {
    const folder = lastFolder.get(engine);
    if (folder === undefined) continue;
    const owners = byFolder.get(folder);
    if (owners) owners.push(engine);
    else byFolder.set(folder, [engine]);
  }
  if (!byFolder.size) return NO_LISTINGS;
  return [...byFolder].map(([folder, owners]) => ({ folder, engines: owners, ...(lastListing.get(folder) ?? NOT_LISTED) }));
}

export function rememberFolderListing(folder: string, reply: FolderMediaListing): boolean {
  const files = reply.status === "ok" ? reply.files.filter(validFile) : NO_FILES;
  const before = lastListing.get(folder);
  if (before && before.status === reply.status && sameFiles(before.files, files)) return false;
  lastListing.set(folder, { status: reply.status, files });
  return true;
}

export function rememberFolders(engines: readonly string[], folders: readonly (string | null)[]): boolean {
  let moved = false;
  engines.forEach((engine, i) => {
    const folder = folders[i];
    if (folder && lastFolder.get(engine) !== folder) moved = !!lastFolder.set(engine, folder);
    else if (!folder && lastFolder.delete(engine)) moved = true;
  });
  return moved;
}

export function followFolderMedia(engines: readonly string[], changed: () => void): () => void {
  let live = true;
  let resolving = 0;
  const tickets = new Map<string, number>();
  const counted = new Set<string>();
  const watched = new Map<string, () => void>();
  const consent = consentToken();
  const refresh = (folder: string) => {
    const mine = (tickets.get(folder) ?? 0) + 1;
    tickets.set(folder, mine);
    void listFolderMedia(folder, FOLDER_MEDIA_LIMIT)
      .catch(() => UNAVAILABLE)
      .then((reply) => {
        if (!live || tickets.get(folder) !== mine) return;
        if (!counted.has(folder)) noteLibraryFolderListing(reply.status === "ok" ? reply.files.length : 0, reply.status, consent);
        counted.add(folder);
        if (rememberFolderListing(folder, reply)) changed();
      });
  };
  const resolve = () => {
    const mine = ++resolving;
    void Promise.all(engines.map((engine) => getDownloadSettings(engine).then((s) => s?.folder || null, () => null))).then((folders) => {
      if (!live || mine !== resolving) return;
      if (rememberFolders(engines, folders)) changed();
      const shown = new Set(folders.filter((f): f is string => !!f));
      for (const [folder, stop] of watched) {
        if (shown.has(folder)) continue;
        stop();
        watched.delete(folder);
      }
      for (const folder of shown) {
        refresh(folder);
        if (!watched.has(folder)) watched.set(folder, watchFolder(folder, () => live && refresh(folder)));
      }
    });
  };
  const stopSettings = onDownloadSettingsChange((profile) => {
    if (live && (!profile || engines.includes(profile))) resolve();
  });
  resolve();
  return () => {
    live = false;
    stopSettings();
    for (const stop of watched.values()) stop();
    watched.clear();
  };
}

export function useFolderMedia(engines: readonly string[], shown: boolean, wanted: boolean): readonly FolderListing[] {
  const key = JSON.stringify(engines);
  const [version, setVersion] = useState(0);
  const live = shown && wanted;

  useEffect(() => {
    const asked: string[] = JSON.parse(key);
    if (!asked.length || !live) return;
    return followFolderMedia(asked, () => setVersion((v) => v + 1));
  }, [key, live]);

  return useMemo(() => folderListings(JSON.parse(key) as string[]), [key, version]);
}
