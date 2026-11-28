import { useBrowser } from "../browser/store";
import { isMiniPlayerCandidate, pinnedWithMediaControls, showsMiniPlayer, useMedia } from "../media/media";
import { consentToken } from "../telemetry/client";
import { noteTabHoverPlayerSkippedBeforePlayback } from "../telemetry/hoverCardCounts";
import type { Target } from "./sidebarUi";

export function cardTargetFor<T extends Target>(target: T | null, cards: boolean, player: boolean): T | null {
  if (cards || !target || player) return target;
  return target.kind === "tab" || target.kind === "folder" ? null : target;
}

export function cardTargetNow<T extends Target>(target: T | null): T | null {
  const s = useBrowser.getState();
  const cards = s.settings.showTabHoverMenu;
  const playerTab = !cards && target?.kind === "tab" ? target.id : undefined;
  const player = !!playerTab && pinnedWithMediaControls(s, playerTab) && showsMiniPlayer(useMedia.getState().sessions[playerTab]);
  return cardTargetFor(target, cards, player);
}

export function noteSkippedHoverPlayer(target: Target | null) {
  const consent = consentToken();
  if (!consent || target?.kind !== "tab" || !pinnedWithMediaControls(useBrowser.getState(), target.id)) return;
  const session = useMedia.getState().sessions[target.id];
  if (isMiniPlayerCandidate(session) && !showsMiniPlayer(session)) noteTabHoverPlayerSkippedBeforePlayback(consent);
}
