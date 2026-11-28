import type { PageMediaEvent } from "@ardia/phone-native";

export type PlayingMedia = {
  pageId: string;
  state: "playing" | "paused";
  isPrivate: boolean;
  hasVideo: boolean;
  title: string;
  artist: string;
  artworkUrl: string | null;
  duration: number | null;
  position: number;
  rate: number;
  at: number;
  startedAt: number;
  canPrevious: boolean;
  canNext: boolean;
  canPictureInPicture: boolean;
  inPictureInPicture: boolean;
};

export type MediaShelf = Readonly<Record<string, PlayingMedia>>;

export type Dismissal = { pageId: string; startedAt: number } | null;

const finiteOr = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const textOf = (value: unknown, longest = 200) => (typeof value === "string" ? value.slice(0, longest) : "");

export function mediaFromEvent(event: PageMediaEvent): PlayingMedia | null {
  if (event.state !== "playing" && event.state !== "paused") return null;
  const duration = typeof event.duration === "number" && Number.isFinite(event.duration) && event.duration > 0 ? event.duration : null;
  return {
    pageId: event.pageId,
    state: event.state,
    isPrivate: event.isPrivate === true,
    hasVideo: event.hasVideo === true,
    title: textOf(event.title),
    artist: textOf(event.artist),
    artworkUrl: typeof event.artworkUrl === "string" && event.artworkUrl.startsWith("https://") ? event.artworkUrl : null,
    duration,
    position: Math.max(0, finiteOr(event.position, 0)),
    rate: Math.max(0, finiteOr(event.rate, 1)),
    at: finiteOr(event.at, 0),
    startedAt: finiteOr(event.startedAt, 0),
    canPrevious: event.canPrevious === true,
    canNext: event.canNext === true,
    canPictureInPicture: event.canPictureInPicture === true,
    inPictureInPicture: event.inPictureInPicture === true,
  };
}

export function shelve(shelf: MediaShelf, event: PageMediaEvent): MediaShelf {
  const media = mediaFromEvent(event);
  if (media) return { ...shelf, [event.pageId]: media };
  if (!shelf[event.pageId]) return shelf;
  const { [event.pageId]: _gone, ...rest } = shelf;
  return rest;
}

export function frontMedia(shelf: MediaShelf, belongs: (media: PlayingMedia) => boolean = () => true): PlayingMedia | null {
  let front: PlayingMedia | null = null;
  for (const media of Object.values(shelf)) {
    if (!belongs(media)) continue;
    if (!front || media.startedAt > front.startedAt || (media.startedAt === front.startedAt && media.state === "playing" && front.state !== "playing")) front = media;
  }
  return front;
}

export const frontMediaOnSide = (shelf: MediaShelf, incognito: boolean, belongs: (media: PlayingMedia) => boolean = () => true) => frontMedia(shelf, (media) => media.isPrivate === incognito && belongs(media));

export type MiniPlayerScene = {
  enabled: boolean;
  surface: "start" | "browsing" | "deck";
  selectedId: string | null;
  covered: boolean;
  incognito: boolean;
  tabExists: boolean;
  dismissed: Dismissal;
};

export function miniPlayerShows(media: PlayingMedia | null, scene: MiniPlayerScene): boolean {
  if (!media || !scene.enabled || scene.covered || !scene.tabExists) return false;
  if (media.isPrivate !== scene.incognito) return false;
  if (scene.surface === "browsing" && scene.selectedId === media.pageId) return false;
  if (scene.dismissed && scene.dismissed.pageId === media.pageId && scene.dismissed.startedAt === media.startedAt) return false;
  return true;
}

export type SkipControl = { kind: "track"; command: "previous" | "next" } | { kind: "seconds"; seconds: number };

export function skipControls(media: Pick<PlayingMedia, "canPrevious" | "canNext" | "duration">, seconds: number): { back: SkipControl | null; forward: SkipControl | null } {
  const seeks = media.duration !== null;
  return {
    back: media.canPrevious ? { kind: "track", command: "previous" } : seeks ? { kind: "seconds", seconds: -seconds } : null,
    forward: media.canNext ? { kind: "track", command: "next" } : seeks ? { kind: "seconds", seconds } : null,
  };
}

export function positionAt(media: Pick<PlayingMedia, "state" | "position" | "rate" | "at" | "duration">, now: number): number {
  const moved = media.state === "playing" ? Math.max(0, (now - media.at) / 1000) * media.rate : 0;
  const position = media.position + moved;
  return media.duration === null ? position : Math.min(position, media.duration);
}

export function withOptimisticState(media: PlayingMedia, state: "playing" | "paused", now: number): PlayingMedia {
  if (media.state === state) return media;
  return { ...media, state, position: positionAt(media, now), at: now };
}

export function miniPlayerLines(media: Pick<PlayingMedia, "title" | "artist">, tabTitle: string, host: string): { title: string; detail: string } {
  const title = media.title.trim() || tabTitle.trim() || host;
  const artist = media.artist.trim();
  return { title, detail: artist && artist !== title ? artist : host };
}
