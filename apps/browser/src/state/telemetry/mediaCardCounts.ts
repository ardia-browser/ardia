import type { NowPlaying } from "../../platform/media";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const REWIND_SECONDS = 1;
const PAST_END_SECONDS = 2;

type PositionReport = Pick<NowPlaying, "playbackState" | "position" | "duration" | "playbackRate" | "timestamp" | "loop">;

let sidebarPlayerExpands = 0;
let sidebarPlayerReopens = 0;
let sidebarPlayerFromOtherProfile = 0;
let loopRestarts = 0;
let rewinds = 0;
let pastEnd = 0;
let commandsNotDone = 0;
let artworkEmpty = 0;

export function sidebarPlayerOpenCounter() {
  let shownOpen = false;
  let closing = false;
  return {
    motionStarted(open: boolean) {
      if (open) {
        sidebarPlayerExpands++;
        if (closing) sidebarPlayerReopens++;
        shownOpen = true;
      }
      closing = !open && shownOpen;
    },
    closeFinished() {
      closing = false;
    },
  };
}

export const noteSidebarPlayerFromOtherProfile = () => void sidebarPlayerFromOtherProfile++;

export const noteNowPlayingLoopRestart = () => void loopRestarts++;

export function noteMediaCommandAnswer(answer: unknown) {
  if (typeof answer === "object" && answer !== null && (answer as { done?: unknown }).done === false) commandsNotDone++;
}

export function noteArtworkAnswer(uri: string | null | undefined, consent?: ConsentToken | null) {
  if (!uri) countFor(consent, () => void artworkEmpty++, { now_playing_artwork_empty: 1 });
}

export function noteMediaPositionReport(before: PositionReport | undefined, report: PositionReport) {
  if (before?.playbackState !== "playing") return;
  const extrapolated = before.position + ((report.timestamp - before.timestamp) / 1000) * (before.playbackRate || 1);
  if (report.position < extrapolated - REWIND_SECONDS) rewinds++;
  if (before.duration && !before.loop && extrapolated > before.duration + PAST_END_SECONDS) pastEnd++;
}

export function takeMediaCardCounts() {
  const taken = { sidebar_player_expands: sidebarPlayerExpands, sidebar_player_reopens: sidebarPlayerReopens, sidebar_player_from_other_profile: sidebarPlayerFromOtherProfile, now_playing_loop_restarts: loopRestarts, media_position_rewinds: rewinds, media_reports_past_end: pastEnd, media_commands_not_done: commandsNotDone, now_playing_artwork_empty: artworkEmpty };
  sidebarPlayerExpands = 0;
  sidebarPlayerReopens = 0;
  sidebarPlayerFromOtherProfile = 0;
  loopRestarts = 0;
  rewinds = 0;
  pastEnd = 0;
  commandsNotDone = 0;
  artworkEmpty = 0;
  return taken;
}
