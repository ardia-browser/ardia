import { create } from "zustand";

type Size = { width: number; height: number };
export type WarmFrame = { x: number; y: number; width: number; height: number };
export type WarmCapture = { uri: string; url: string; window: Size; frame: WarmFrame | null | undefined; settled: boolean | undefined; view: number | undefined; viewId: number | undefined; generation?: number };
type WarmKey = { uri: string; url: string; window: Size; frame: WarmFrame; view: number; viewId: number; generation: number | null };
type Watermark = { viewId: number; version: number };
export type WarmPicture = { uri: string; frame: WarmFrame };

const keys = new Map<string, WarmKey>();
const watermarks = new Map<string, Watermark>();

export const useWarmRevision = create<{ revision: number }>()(() => ({ revision: 0 }));
const changed = () => useWarmRevision.setState((state) => ({ revision: state.revision + 1 }));

const atRest = (frame: WarmFrame, window: Size) => Math.abs(frame.x) < 1 && Math.abs(frame.width - window.width) < 1 && frame.height > 0 && frame.y >= 0 && frame.y + frame.height <= window.height + 1;

const movedSince = (id: string, viewId: number, view: number) => {
  const mark = watermarks.get(id);
  if (!mark) return false;
  return mark.viewId !== viewId || mark.version > view;
};

export function noteWarmPicture(id: string, capture: WarmCapture) {
  const { frame, view, viewId } = capture;
  const usable = capture.settled === true && frame && atRest(frame, capture.window) && view !== undefined && viewId !== undefined && viewId !== 0 && !movedSince(id, viewId, view);
  if (!usable) {
    if (keys.delete(id)) changed();
    return;
  }
  keys.set(id, { uri: capture.uri, url: capture.url, window: { ...capture.window }, frame: { ...frame }, view, viewId, generation: capture.generation ?? null });
  changed();
}

export function noteViewMoved(id: string, viewId: number, version: number) {
  const mark = watermarks.get(id);
  if (mark && mark.viewId === viewId && mark.version >= version) return;
  watermarks.set(id, { viewId, version: mark && mark.viewId === viewId ? Math.max(mark.version, version) : version });
  changed();
}

const shownGenerations = new Map<string, number>();

export function noteShownPictureGeneration(id: string, generation: number) {
  if (generation <= (shownGenerations.get(id) ?? 0)) return;
  shownGenerations.set(id, generation);
  changed();
}

export function warmPicture(tab: { id: string; url: string; snapshotFileName: string | null }, window: Size): WarmPicture | null {
  const key = keys.get(tab.id);
  if (!key || key.uri !== tab.snapshotFileName || key.url !== tab.url) return null;
  if (key.window.width !== window.width || key.window.height !== window.height) return null;
  if (movedSince(tab.id, key.viewId, key.view)) return null;
  if (key.generation !== null && key.generation < (shownGenerations.get(tab.id) ?? 0)) return null;
  return { uri: key.uri, frame: key.frame };
}

export function useWarmPicture(tab: { id: string; url: string; snapshotFileName: string | null }, window: Size, enabled: boolean): WarmPicture | null {
  useWarmRevision((state) => state.revision);
  return enabled ? warmPicture(tab, window) : null;
}

const decoded = new Map<string, string>();

export function noteWarmDecoded(id: string, uri: string) {
  decoded.set(id, uri);
}

export const warmDecoded = (id: string, uri: string) => decoded.get(id) === uri;

export function forgetWarmPictures(ids: readonly string[]) {
  let any = false;
  for (const id of ids) {
    any = keys.delete(id) || any;
    watermarks.delete(id);
    decoded.delete(id);
  }
  if (any) changed();
}
