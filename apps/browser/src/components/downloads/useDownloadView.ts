import { useEffect, useRef, useState } from "react";
import { fileExists } from "../../state/app/system";
import type { Download } from "../../state/downloads/actions";
import { awaitsKeep } from "../../state/downloads/status";
import { onDownloadsChanged } from "../../state/windows/downloadWatch";

const KNOWN_FOR_MS = 2000;
const MAX_KNOWN = 2048;
const known = new Map<string, { exists: boolean; at: number }>();
const rechecks = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function existsNow(path: string): boolean {
  const now = Date.now();
  const hit = known.get(path);
  if (hit && now - hit.at < KNOWN_FOR_MS) return hit.exists;
  const exists = fileExists(path);
  if (known.size >= MAX_KNOWN) known.clear();
  known.set(path, { exists, at: now });
  return exists;
}

function watchDownloads(recheck: () => void) {
  rechecks.add(recheck);
  stopWatching ??= onDownloadsChanged(() => {
    known.clear();
    for (const run of [...rechecks]) run();
  });
  return () => {
    rechecks.delete(recheck);
    if (rechecks.size || !stopWatching) return;
    stopWatching();
    stopWatching = null;
  };
}

export function useDownloadView(d: Download) {
  const finishedPath = d.state === "finished" ? d.path : null;
  const exists = finishedPath === null || existsNow(finishedPath);
  const shown = useRef(exists);
  shown.current = exists;
  const [, recheck] = useState(0);
  useEffect(() => {
    if (finishedPath === null) return;
    return watchDownloads(() => {
      if (existsNow(finishedPath) !== shown.current) recheck((n) => n + 1);
    });
  }, [finishedPath]);
  return {
    exists,
    done: d.state === "finished" && exists,
    progress: d.total > 0 ? d.received / d.total : 0,
    blocked: awaitsKeep(d),
  };
}
