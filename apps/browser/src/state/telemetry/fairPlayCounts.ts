import type { FairPlayReport } from "../../platform/tabs";

type FairPlayStep = NonNullable<FairPlayReport["step"]>;
type FairPlayCounts = { played: number; failed: Record<FairPlayStep, number>; mirrored: number; mirrorResyncs: number; pip: number; pipUnfitted: number; pipReopens: number; choppy: number; nowPlayingCommands: number };

const FAIRPLAY_STEPS: readonly FairPlayStep[] = ["license", "playback", "player"];

const emptyCounts = (): FairPlayCounts => ({
  played: 0,
  failed: { license: 0, playback: 0, player: 0 },
  mirrored: 0,
  mirrorResyncs: 0,
  pip: 0,
  pipUnfitted: 0,
  pipReopens: 0,
  choppy: 0,
  nowPlayingCommands: 0,
});

let tracks = emptyCounts();
let videos = emptyCounts();
let youtube = emptyCounts();

const isFairPlayStep = (step: unknown): step is FairPlayStep => FAIRPLAY_STEPS.includes(step as FairPlayStep);

export function noteFairPlay(report: FairPlayReport) {
  const counts = report?.site === "youtube" ? youtube : report?.video === true ? videos : tracks;
  if (report?.event === "played") counts.played++;
  else if (report?.event === "failed" && isFairPlayStep(report.step)) counts.failed[report.step]++;
  else if (report?.event === "mirrored" && report.video === true) videos.mirrored++;
  else if (report?.event === "mirrorResync" && report.video === true) videos.mirrorResyncs++;
  else if (report?.event === "pip" && report.video === true && report.site !== "youtube") {
    videos.pip++;
    if (report.fitted !== true) videos.pipUnfitted++;
  } else if (report?.event === "pipReopen" && report.video === true && report.site !== "youtube") videos.pipReopens++;
  else if (report?.event === "choppy" && report.video === true && report.site !== "youtube") videos.choppy++;
  else if (report?.event === "nowPlayingCommand" && report.video === true) counts.nowPlayingCommands++;
}

export function takeFairPlayCounts() {
  const taken = {
    fairplay_played: tracks.played,
    fairplay_failed_license: tracks.failed.license,
    fairplay_failed_playback: tracks.failed.playback,
    fairplay_failed_player: tracks.failed.player,
    fairplay_video_played: videos.played,
    fairplay_video_failed_license: videos.failed.license,
    fairplay_video_failed_playback: videos.failed.playback,
    fairplay_video_failed_player: videos.failed.player,
    fairplay_video_mirrored: videos.mirrored,
    fairplay_video_mirror_resyncs: videos.mirrorResyncs,
    fairplay_video_pip: videos.pip,
    fairplay_video_pip_unfitted: videos.pipUnfitted,
    fairplay_video_pip_reopens: videos.pipReopens,
    fairplay_video_choppy: videos.choppy,
    fairplay_video_now_playing_commands: videos.nowPlayingCommands,
    fairplay_youtube_played: youtube.played,
    fairplay_youtube_failed_license: youtube.failed.license,
    fairplay_youtube_failed_playback: youtube.failed.playback,
    fairplay_youtube_failed_player: youtube.failed.player,
    fairplay_youtube_now_playing_commands: youtube.nowPlayingCommands,
  };
  tracks = emptyCounts();
  videos = emptyCounts();
  youtube = emptyCounts();
  return taken;
}
