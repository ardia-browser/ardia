import type { Check } from "./check";
import { checks as engineAutoplayChecks } from "./engineAutoplay";
import { checks as engineAutoplayAskChecks } from "./engineAutoplayAsks";
import { checks as engineNowPlayingChecks } from "./engineNowPlaying";
import { checks as engineNowPlayingAskChecks } from "./engineNowPlayingAsks";
import { checks as engineNowPlayingMutedChecks } from "./engineNowPlayingMuted";
import { checks as engineNowPlayingArtworkChecks } from "./engineNowPlayingArtwork";
import { checks as engineNowPlayingEndedChecks } from "./engineNowPlayingEnded";
import { checks as engineNowPlayingSessionChecks } from "./engineNowPlayingSessions";
import { checks as engineNowPlayingProfileChecks } from "./engineNowPlayingProfiles";

export const mediaStage: Check[] = [
  ...engineAutoplayChecks,
  ...engineAutoplayAskChecks,
  ...engineNowPlayingChecks,
  ...engineNowPlayingAskChecks,
  ...engineNowPlayingMutedChecks,
  ...engineNowPlayingArtworkChecks,
  ...engineNowPlayingEndedChecks,
  ...engineNowPlayingSessionChecks,
  ...engineNowPlayingProfileChecks,
];
