import { useMemo } from "react";
import type { Download } from "../../platform/downloads";
import { useBrowser } from "../browser/store";
import { useDownloadProgress, withProgress } from "./progress";

const indexes = new WeakMap<readonly Download[], Map<string, Download>>();

export function downloadById(downloads: readonly Download[], id: string): Download | undefined {
  if (downloads.length < 16) return downloads.find((d) => d.id === id);
  let byId = indexes.get(downloads);
  if (!byId) {
    byId = new Map();
    for (const d of downloads) if (!byId.has(d.id)) byId.set(d.id, d);
    indexes.set(downloads, byId);
  }
  return byId.get(id);
}

export function useDownload(id: string) {
  const download = useBrowser((s) => downloadById(s.downloads, id));
  const progress = useDownloadProgress((s) => s[id]);
  return useMemo(() => withProgress(download, progress), [download, progress]);
}
