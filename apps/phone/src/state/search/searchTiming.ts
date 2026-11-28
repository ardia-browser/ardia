import { useEffect } from "react";
import { labLog } from "../../platform/lab";
import { interactionPerfEnabled } from "../app/interactionPerf";
import { reportSearchOpen, reportSearchSuggest } from "../telemetry/telemetry";

const PRESS_COUNTS_FOR_MS = 1000;

let pressedAt: number | null = null;
let closedAt: number | null = null;
let openingSince: number | null = null;
let openingPrivate = false;
let firstTypedAt: number | null = null;
let localMs: number | null = null;
let suggestPrivate = false;

const dropSuggestSample = () => {
  firstTypedAt = null;
  localMs = null;
};

export function markSearchPressed(at: number = Date.now(), incognito = false) {
  openingSince = at;
  openingPrivate = incognito;
  firstTypedAt = null;
  localMs = null;
  if (!interactionPerfEnabled()) return;
  if (pressedAt !== null && at - pressedAt < PRESS_COUNTS_FOR_MS) return;
  pressedAt = at;
  closedAt = null;
  labLog("PAGELAB search press 0");
}

export function markSearchPhase(phase: string) {
  if (pressedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB search ${phase} ${Date.now() - pressedAt}`);
}

export function markSearchPresented() {
  markSearchPhase("presented");
  if (openingSince === null) return;
  const ms = Date.now() - openingSince;
  openingSince = null;
  if (!openingPrivate) reportSearchOpen(ms);
}

export function markSearchTyped(typedAt: number, incognito: boolean) {
  if (firstTypedAt !== null && suggestPrivate === incognito) return;
  firstTypedAt = typedAt;
  localMs = null;
  suggestPrivate = incognito;
}

export function markSearchLocalRows(typedAt: number) {
  const now = Date.now();
  if (typedAt === firstTypedAt && localMs === null) localMs = now - typedAt;
  if (interactionPerfEnabled()) labLog(`PAGELAB search local ${now - typedAt}`);
}

export function markSearchRemoteRows(typedAt: number, sentAt: number, cached: boolean, incognito: boolean) {
  const now = Date.now();
  if (interactionPerfEnabled()) labLog(`PAGELAB search remote ${now - typedAt} sent ${sentAt - typedAt} ${cached ? "cached" : `wait ${now - sentAt}`}`);
  if (firstTypedAt === null || localMs === null || incognito !== suggestPrivate) return;
  const remoteMs = now - firstTypedAt;
  const local = localMs;
  const privately = suggestPrivate;
  dropSuggestSample();
  if (!privately && !incognito) reportSearchSuggest(local, remoteMs);
}

export function markSearchClosing() {
  openingSince = null;
  dropSuggestSample();
  if (!interactionPerfEnabled()) return;
  pressedAt = null;
  closedAt = Date.now();
  labLog("PAGELAB search close 0");
}

export function markSearchClosePhase(phase: string) {
  if (closedAt === null || !interactionPerfEnabled()) return;
  labLog(`PAGELAB search ${phase} ${Date.now() - closedAt}`);
}

export const endSearchTiming = () => {
  pressedAt = null;
  closedAt = null;
};

export function useGlassTrace(name: string, glass: { shown: boolean; shownMs: number }) {
  useEffect(() => {
    if (!interactionPerfEnabled()) return;
    const since = closedAt !== null ? ` close+${Date.now() - closedAt}` : pressedAt !== null ? ` press+${Date.now() - pressedAt}` : "";
    labLog(`PAGELAB glass ${name} ${glass.shown ? "shown" : "hidden"} ${glass.shownMs}${since}`);
  }, [glass.shown, glass.shownMs]);
}
