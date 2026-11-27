import { useEffect, useState } from "react";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { fieldBlurCause, watchFieldBlurs } from "../../platform/focus";
import { onWindowEvent, type WindowEvent } from "../../platform/windows";
import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { notePageOverlay } from "../telemetry/usage";

type Cancel = () => void;
type Hold = { field: number; cancel: Cancel; consent: ConsentToken | null };

const held = new Map<string, Hold>();
let listening = false;

function close(windowId: string, hold: Hold) {
  held.delete(windowId);
  if (!useBrowser.getState().windowUi[windowId]?.panel.open) return;
  notePageOverlay("barClosedAfterKeyLoss", hold.consent);
  hold.cancel();
}

function onFocus(e: Extract<WindowEvent, { type: "focus" }>) {
  for (const [windowId, hold] of [...held]) if (windowId !== e.id) close(windowId, hold);
  const hold = held.get(e.id);
  if (!hold) return;
  if (!e.restored || e.field !== hold.field) return close(e.id, hold);
  held.delete(e.id);
  notePageOverlay("barFocusRestored", hold.consent);
}

function listen() {
  if (listening) return;
  listening = true;
  onWindowEvent((e) => {
    if (e.type === "focus") onFocus(e);
    else if (e.type === "close") held.delete(e.id);
  });
  useBrowser.subscribeTo(["windows"], (s, before) => {
    if (s.windows === before.windows) return;
    for (const windowId of [...held.keys()]) if (!s.windows[windowId]) held.delete(windowId);
  });
}

function holdBarOnKeyLoss(windowId: string, field: number | null, cancel: Cancel): boolean {
  if (!PLATFORM_FEATURES.holdsBarOnKeyLoss || field == null || fieldBlurCause(field) !== "keyLoss") return false;
  listen();
  const consent = consentToken();
  held.set(windowId, { field, cancel, consent });
  notePageOverlay("barHeldOnKeyLoss", consent);
  return true;
}

export function watchBarField(field: number | null): () => void {
  if (!PLATFORM_FEATURES.holdsBarOnKeyLoss || field == null) return () => {};
  watchFieldBlurs(field, true);
  return () => watchFieldBlurs(field, false);
}

export function barBlurred(windowId: string, field: number | null, cancel: Cancel) {
  if (!holdBarOnKeyLoss(windowId, field, cancel)) cancel();
}

export function barRefocused(windowId: string, field: number | null) {
  const hold = held.get(windowId);
  if (!hold || hold.field !== field) return;
  held.delete(windowId);
  notePageOverlay("barFocusRestored", hold.consent);
}

export function heldBarDismissed(windowId: string) {
  const hold = held.get(windowId);
  if (!hold) return;
  held.delete(windowId);
  notePageOverlay("barClosedAfterKeyLoss", hold.consent);
}

export function releaseBarHold(windowId: string, cancel: Cancel) {
  if (held.get(windowId)?.cancel === cancel) held.delete(windowId);
}

export function useHeldBarCancel(latest: () => { windowId: string; onCancel?: () => void }): Cancel {
  const [cancel] = useState(() => () => latest().onCancel?.());
  useEffect(() => () => releaseBarHold(latest().windowId, cancel), []);
  return cancel;
}

export const heldBars = (): readonly string[] => [...held.keys()];
