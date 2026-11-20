import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDownloads } from "../../state/browser/hooks";
import type { Download } from "../../state/downloads/actions";
import { awaitsKeep } from "../../state/downloads/status";
import { noteLibraryFooterState } from "../../state/telemetry/libraryCounts";
import { LIBRARY } from "./tokens";

export type LibraryGlyph = keyof typeof LIBRARY.footer.symbols;

type Activity = "idle" | "downloading" | "blocked";

function activityOf(list: readonly Download[]): [Activity, number] {
  let activity: Activity = "idle";
  let finished = 0;
  for (const d of list) {
    if (awaitsKeep(d)) activity = "blocked";
    else if (d.state === "downloading" && activity === "idle") activity = "downloading";
    else if (d.state === "finished") finished++;
  }
  return [activity, finished];
}

export const LIBRARY_GLYPH_LABELS: Record<LibraryGlyph, string> = {
  idle: "Library",
  open: "Library",
  downloading: "Library, downloading",
  finished: "Library, download finished",
  blocked: "Library, a download needs Keep or Discard",
};

export function useLibraryGlyph(windowId: string, open: boolean): LibraryGlyph {
  const [activity, finished] = useDownloads(windowId, useShallow(activityOf));
  const [justFinished, setJustFinished] = useState(false);
  const last = useRef({ activity, finished });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = last.current;
    last.current = { activity, finished };
    if (activity !== "idle" || finished <= was.finished || was.activity !== "downloading") {
      if (activity !== "idle") setJustFinished(false);
      return;
    }
    setJustFinished(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setJustFinished(false);
    }, LIBRARY.footer.finishedHold);
  }, [activity, finished]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const glyph: LibraryGlyph = open ? "open" : activity !== "idle" ? activity : justFinished ? "finished" : "idle";
  useEffect(() => {
    if (glyph === "downloading" || glyph === "finished" || glyph === "blocked") noteLibraryFooterState(glyph);
  }, [glyph]);
  return glyph;
}
