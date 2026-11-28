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
import { frontMediaOnSide, miniPlayerShows, sessionsAfter, shelve, withPending, withSession, type MediaShelf, type PendingState, type PlayingMedia, type Sessions, type SkipControl } from "./nowPlaying";

type MediaState = { shelf: MediaShelf; pending: Readonly<Record<string, PendingState>>; dismissed: Sessions; counted: Sessions };

export const useMedia = create<MediaState>()(() => ({ shelf: {}, pending: {}, dismissed: {}, counted: {} }));

export const PENDING_CONFIRM_MS = 2_000;

const dropPending = (pageId: string) =>
  useMedia.setState((state) => {
    if (!state.pending[pageId]) return state;
    const { [pageId]: _done, ...pending } = state.pending;
    return { pending };
  });

export const mediaOffered = () => pages.reportsMedia();

export const useMiniPlayerRoom = create<{ room: number }>()(() => ({ room: 0 }));

export const setMiniPlayerRoom = (room: number) => {
  if (useMiniPlayerRoom.getState().room !== room) useMiniPlayerRoom.setState({ room });
};

export function takeMediaEvent(event: PageMediaEvent) {
  useMedia.setState((state) => {
    const shelf = shelve(state.shelf, event);
    const dismissed = sessionsAfter(state.dismissed, event);
    const counted = sessionsAfter(state.counted, event);
    const { [event.pageId]: _answered, ...pending } = state.pending;
    return shelf === state.shelf && !state.pending[event.pageId] && dismissed === state.dismissed && counted === state.counted ? state : { shelf, pending, dismissed, counted };
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

const tellPage = (media: PlayingMedia, command: PageMediaCommand, seconds?: number): Promise<boolean> => pages.mediaCommand(media.pageId, command, seconds).catch(() => false);

export function toggleMediaPlayback(media: PlayingMedia) {
  const next = media.state === "playing" ? "paused" : "playing";
  const until = Date.now() + PENDING_CONFIRM_MS;
  useMedia.setState((state) => ({ pending: { ...state.pending, [media.pageId]: { state: next, until } } }));
  setTimeout(() => {
    if (useMedia.getState().pending[media.pageId]?.until === until) dropPending(media.pageId);
  }, PENDING_CONFIRM_MS);
  void tellPage(media, next === "playing" ? "play" : "pause").then((accepted) => {
    if (!accepted && useMedia.getState().pending[media.pageId]?.until === until) dropPending(media.pageId);
  });
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
  useMedia.setState((state) => ({ dismissed: withSession(state.dismissed, media) }));
  countFor(media, "mini_player_closed");
}

export function openMiniPlayerTab(media: PlayingMedia) {
  countFor(media, "mini_player_returned");
  returnToMediaTab(media.pageId);
}

export function noteMiniPlayerShown(media: PlayingMedia) {
  const { counted } = useMedia.getState();
  if (counted[media.pageId] === media.startedAt) return;
  useMedia.setState({ counted: withSession(counted, media) });
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
  const confirmed = useMedia((s) => s.shelf);
  const pending = useMedia((s) => s.pending);
  const shelf = withPending(confirmed, pending, Date.now());
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
  const media = enabled ? frontMediaOnSide(shelf, incognito, (one) => {
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
