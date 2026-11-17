import { openFile, revealFile } from "../../platform/files";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";

const ARCHIVE = /\.(?:zip|tar|tgz|tbz|tbz2|txz|cpio|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|xz)$/i;

export type OpenDownloadDeps = {
  open: (path: string) => Promise<boolean>;
  reveal: (path: string) => Promise<boolean>;
};

const SYSTEM: OpenDownloadDeps = { open: openFile, reveal: revealFile };

export const isArchive = (path: string) => ARCHIVE.test(path);

export async function openDownload(path: string, deps: OpenDownloadDeps = SYSTEM): Promise<boolean> {
  if (!PLATFORM_FEATURES.unpacksArchivesSilently || !isArchive(path)) return deps.open(path);
  if (!(await deps.open(path))) return false;
  noteDownloadsPanel("archiveOpen");
  await deps.reveal(path);
  return true;
}
