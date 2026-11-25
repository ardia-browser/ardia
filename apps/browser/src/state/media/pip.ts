import { setDisplayMediaPicker } from "../../platform/media";
import { useRef } from "react";
import { useBrowser } from "../browser/store";
import { useStoreWhile } from "../tabs/tabWatch";
import { usePages } from "../tabs/pageState";
import { startCast } from "./cast";
import { cancelDisplayMediaOnNavigation, startTabShareCleanup } from "./screenShare";
import { useTabLive } from "../browser/hooks";

export function useAutoPictureInPicture(tabId: string, visible: boolean): boolean {
  const enabled = useStoreWhile(useBrowser, visible, (s) => s.settings.autoPictureInPicture);
  const audible = useTabLive(visible ? tabId : undefined, (l) => l.playingAudio);
  const capturing = useStoreWhile(usePages, visible, (s) => !!s.pages[tabId]?.mediaAccess);
  const decided = useRef(false);
  if (visible) decided.current = enabled && (audible || capturing);
  return decided.current;
}

let started = false;

export function startMedia() {
  if (started) return;
  started = true;
  void setDisplayMediaPicker(true);
  cancelDisplayMediaOnNavigation();
  startTabShareCleanup();
  startCast();
}
