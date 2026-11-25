import { create } from "zustand";

type PeekToolbarPreview = { tabId: string; sourceId: string };

export const usePeekToolbarPreview = create<Record<string, PeekToolbarPreview>>()(() => ({}));

export function previewPeekToolbar(windowId: string, tabId: string, sourceId: string) {
  usePeekToolbarPreview.setState({ ...usePeekToolbarPreview.getState(), [windowId]: { tabId, sourceId } }, true);
}

export function endPeekToolbarPreview(windowId: string, tabId: string) {
  const current = usePeekToolbarPreview.getState()[windowId];
  if (!current || current.tabId !== tabId) return;
  const next = { ...usePeekToolbarPreview.getState() };
  delete next[windowId];
  usePeekToolbarPreview.setState(next, true);
}

export const previewedToolbarTab = (previews: Record<string, PeekToolbarPreview>, tabId: string) =>
  Object.values(previews).find((p) => p.sourceId === tabId)?.tabId ?? tabId;
