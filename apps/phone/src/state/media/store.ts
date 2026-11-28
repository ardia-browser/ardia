import { create } from "zustand";
import { pages, type PageMediaCommand, type PageMediaEvent, type WebVideoOutcome } from "../../platform/pages";
import type { Counted } from "../../lib/telemetrySchema";
import { openTab, useBrowse } from "../browse/store";
import { useLibrary } from "../library/store";
import { useOnboarding } from "../onboarding/store";
import { usePageUi } from "../page/store";
import { useSearch } from "../search/store";
import { offerPictureInPicturePage, useSettingsNav } from "../settings/nav";
import { currentPreferences, usePreferences } from "../settings/store";
import { belongsToSpace } from "../tabs/spaces";
import { currentTabs, useTabs } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { countUsage } from "../telemetry/telemetry";
import { useVoice } from "../voice/store";
import { frontMedia, miniPlayerShows, shelve, withOptimisticState, type Dismissal, type MediaShelf, type PlayingMedia, type SkipControl } from "./nowPlaying";

type MediaState = { shelf: MediaShelf; dismissed: Dismissal; counted: string | null };

export const useMedia = create<MediaState>()(() => ({ shelf: {}, dismissed: null, counted: null }));

export const mediaOffered = () => pages.reportsMedia();

export const useMiniPlayerRoom = create<{ room: number }>()(() => ({ room: 0 }));

export const setMiniPlayerRoom = (room: number) => {
  if (useMiniPlayerRoom.getState().room !== room) useMiniPlayerRoom.setState({ room });
};

export function takeMediaEvent(event: PageMediaEvent) {
  useMedia.setState((state) => {
    const shelf = shelve(state.shelf, event);
    return shelf === state.shelf ? state : { shelf };
  });
}

const WEB_VIDEO_COUNTS: Record<WebVideoOutcome, Counted> = {
  floated: "web_videos_floated",
  keptPlaying: "web_videos_kept_playing",
  playingInBackground: "media_kept_playing_background",
  resumeRefused: "media_resumes_refused",
  pictureInPictureStarted: "auto_pip_started",
  pictureInPictureRefused: "auto_pip_refused",
  returnedToTab: "pip_returned_to_tab",
};

export const webVideoCount = (outcome: WebVideoOutcome): Counted | null => WEB_VIDEO_COUNTS[outcome] ?? null;

export function returnToMediaTab(pageId: string) {
  if (!findTab(currentTabs(), pageId)) return;
  openTab(pageId);
}

const countFor = (media: PlayingMedia, field: Counted) => {
  if (!media.isPrivate) countUsage(field);
};

const tellPage = (media: PlayingMedia, command: PageMediaCommand, seconds?: number) => {
  void pages.mediaCommand(media.pageId, command, seconds).catch(() => false);
};

function showOptimistic(media: PlayingMedia, state: "playing" | "paused") {
  useMedia.setState((now) => {
    const current = now.shelf[media.pageId];
    if (!current) return now;
    return { shelf: { ...now.shelf, [media.pageId]: withOptimisticState(current, state, Date.now()) } };
  });
}

export function toggleMediaPlayback(media: PlayingMedia) {
  const next = media.state === "playing" ? "paused" : "playing";
  showOptimistic(media, next);
  tellPage(media, next === "playing" ? "play" : "pause");
  countFor(media, "mini_player_controls_used");
}

export function skipMedia(media: PlayingMedia, control: SkipControl) {
  if (control.kind === "track") tellPage(media, control.command);
  else tellPage(media, "skip", control.seconds);
  countFor(media, "mini_player_controls_used");
}

export function floatMedia(media: PlayingMedia) {
  tellPage(media, media.inPictureInPicture ? "leavePictureInPicture" : "pictureInPicture");
  countFor(media, "mini_player_controls_used");
}

export function closeMiniPlayer(media: PlayingMedia) {
  useMedia.setState({ dismissed: { pageId: media.pageId, startedAt: media.startedAt } });
  countFor(media, "mini_player_closed");
}

export function openMiniPlayerTab(media: PlayingMedia) {
  countFor(media, "mini_player_returned");
  returnToMediaTab(media.pageId);
}

export function noteMiniPlayerShown(media: PlayingMedia) {
  const session = `${media.pageId}:${media.startedAt}`;
  if (useMedia.getState().counted === session) return;
  useMedia.setState({ counted: session });
  countFor(media, "mini_player_shown");
}

let settingsSent = "";

export function startMediaSettings() {
  offerPictureInPicturePage(mediaOffered);
  if (!mediaOffered()) return;
  const push = () => {
    const { autoPictureInPicture, keepsPlaying, mediaSkipSeconds } = currentPreferences();
    const settings = { automaticPictureInPicture: autoPictureInPicture, keepsPlaying, skipSeconds: mediaSkipSeconds };
    const key = JSON.stringify(settings);
    if (key === settingsSent) return;
    settingsSent = key;
    void pages.setMediaSettings(settings).catch(() => undefined);
  };
  push();
  usePreferences.subscribe(push);
}

export type MiniPlayerView = { media: PlayingMedia | null; shows: boolean; skipSeconds: number };

export function useMiniPlayer(): MiniPlayerView {
  const enabled = usePreferences((p) => p.miniPlayer) && mediaOffered();
  const everySpace = usePreferences((p) => p.miniPlayerEverySpace);
  const skipSeconds = usePreferences((p) => p.mediaSkipSeconds);
  const shelf = useMedia((s) => s.shelf);
  const dismissed = useMedia((s) => s.dismissed);
  const surface = useBrowse((s) => s.surface);
  const sheet = useBrowse((s) => s.sheet);
  const selectedId = useTabs((s) => s.selectedId);
  const incognito = useTabs((s) => s.incognito);
  const spaces = useTabs((s) => s.spaces);
  const open = useTabs((s) => s.open);
  const privates = useTabs((s) => s.privates);
  const searching = useSearch((s) => s.open);
  const pageCovered = usePageUi((ui) => ui.menuOpen || ui.readerTabId !== null || ui.press !== null);
  const libraryOpen = useLibrary((s) => s.open);
  const settingsOpen = useSettingsNav((s) => s.open);
  const onboarding = useOnboarding((s) => s.showing);
  const voice = useVoice((s) => s.presented);
  const tabOf = (pageId: string) => open.find((tab) => tab.id === pageId) ?? privates.find((tab) => tab.id === pageId) ?? null;
  const media = enabled ? frontMedia(shelf, (one) => {
    const tab = tabOf(one.pageId);
    return tab !== null && (everySpace || tab.isPrivate || belongsToSpace(spaces, tab.profileSyncId));
  }) : null;
  const shows = miniPlayerShows(media, {
    enabled,
    surface,
    selectedId,
    covered: searching || pageCovered || libraryOpen || settingsOpen || onboarding || voice || sheet !== null,
    incognito,
    tabExists: media !== null && tabOf(media.pageId) !== null,
    dismissed,
  });
  return { media, shows, skipSeconds };
}
