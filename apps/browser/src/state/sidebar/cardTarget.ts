import { useBrowser } from "../browser/store";
import { pinnedWithMediaControls, useMedia } from "../media/media";
import type { Target } from "./sidebarUi";

export function cardTargetFor<T extends Target>(target: T | null, cards: boolean, player: boolean): T | null {
  if (cards || !target || player) return target;
  return target.kind === "tab" || target.kind === "folder" ? null : target;
}

function playerShowing(tabId: string): boolean {
  const session = useMedia.getState().sessions[tabId];
  return !!session && session.controllable && session.playbackState !== "none" && !!(session.title || session.artwork);
}

export function cardTargetNow<T extends Target>(target: T | null): T | null {
  const s = useBrowser.getState();
  const cards = s.settings.showTabHoverMenu;
  const playerTab = !cards && target?.kind === "tab" ? target.id : undefined;
  const player = !!playerTab && pinnedWithMediaControls(s, playerTab) && playerShowing(playerTab);
  return cardTargetFor(target, cards, player);
}
