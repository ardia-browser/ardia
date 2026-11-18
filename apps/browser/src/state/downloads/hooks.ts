import { useMemo } from "react";
import { useBrowser } from "../browser/store";
import { useDownloadProgress, withProgress } from "./progress";

export function useDownload(id: string) {
  const download = useBrowser((s) => s.downloads.find((d) => d.id === id));
  const progress = useDownloadProgress((s) => s[id]);
  return useMemo(() => withProgress(download, progress), [download, progress]);
}
