import type { BrowserTab } from "./tabModels";
import { noteShownPictureGeneration } from "./warmPictures";

const durableWhileShowing = new Map<string, string | null>();
const shownGeneration = new Map<string, number>();
const landedGeneration = new Map<string, number>();

export type PictureStep = { show: string | null; durable: string | null | undefined };

export function pictureCaptured(tab: BrowserTab, uri: string, durable: boolean, generation: number | undefined): PictureStep | null {
  if (generation !== undefined) {
    if (generation < (shownGeneration.get(tab.id) ?? 0)) return null;
    shownGeneration.set(tab.id, generation);
    noteShownPictureGeneration(tab.id, generation);
  }
  if (durable) {
    durableWhileShowing.delete(tab.id);
    if (generation !== undefined) landedGeneration.set(tab.id, Math.max(generation, landedGeneration.get(tab.id) ?? 0));
    return { show: uri, durable: undefined };
  }
  if (!durableWhileShowing.has(tab.id)) durableWhileShowing.set(tab.id, persistedPicture(tab));
  return { show: uri, durable: durableWhileShowing.get(tab.id) };
}

export function pictureLanded(tab: BrowserTab, uri: string, generation: number): "shown" | "durable" | null {
  if (generation <= (landedGeneration.get(tab.id) ?? 0)) return null;
  landedGeneration.set(tab.id, generation);
  if (generation >= (shownGeneration.get(tab.id) ?? 0)) {
    shownGeneration.set(tab.id, generation);
    noteShownPictureGeneration(tab.id, generation);
    durableWhileShowing.delete(tab.id);
    return "shown";
  }
  durableWhileShowing.set(tab.id, uri);
  return "durable";
}


export const persistedPicture = (tab: BrowserTab): string | null => (durableWhileShowing.has(tab.id) ? durableWhileShowing.get(tab.id)! : tab.snapshotFileName);

export const forTheDatabase = (tab: BrowserTab): BrowserTab => (durableWhileShowing.has(tab.id) ? { ...tab, snapshotFileName: durableWhileShowing.get(tab.id)! } : tab);

export function forgetPictures(ids: readonly string[]) {
  for (const id of ids) {
    durableWhileShowing.delete(id);
    shownGeneration.delete(id);
    landedGeneration.delete(id);
  }
}
