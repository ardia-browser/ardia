import assert from "node:assert/strict";
import { test } from "node:test";
import type { PageMediaEvent } from "@ardia/phone-native";
import { frontMedia, mediaFromEvent, miniPlayerLines, miniPlayerShows, positionAt, shelve, skipControls, withOptimisticState, type MiniPlayerScene, type PlayingMedia } from "./nowPlaying.ts";

const event = (pageId: string, fields: Partial<PageMediaEvent> = {}): PageMediaEvent => ({
  name: "pages.media",
  pageId,
  state: "playing",
  isPrivate: false,
  hasVideo: true,
  title: "Big Buck Bunny",
  artist: "Blender",
  artworkUrl: "https://i.ytimg.com/vi/x/hq.jpg",
  duration: 600,
  position: 30,
  rate: 1,
  at: 1_000,
  startedAt: 500,
  canPrevious: false,
  canNext: false,
  canPictureInPicture: true,
  inPictureInPicture: false,
  ...fields,
});

const media = (pageId: string, fields: Partial<PageMediaEvent> = {}) => mediaFromEvent(event(pageId, fields))!;

const scene = (fields: Partial<MiniPlayerScene> = {}): MiniPlayerScene => ({ enabled: true, surface: "browsing", selectedId: "other", covered: false, incognito: false, tabExists: true, dismissed: null, ...fields });

test("a page that stops reporting media leaves the shelf, and one that never reported is left alone", () => {
  const shelf = shelve({}, event("a"));
  assert.equal(shelf.a?.title, "Big Buck Bunny");
  assert.deepEqual(shelve(shelf, event("a", { state: "none" })), {});
  assert.equal(shelve(shelf, event("b", { state: "none" })), shelf);
});

test("only plain https artwork and finite numbers are kept from the engine", () => {
  const kept = media("a", { artworkUrl: "javascript:alert(1)", duration: Number.POSITIVE_INFINITY, position: Number.NaN, rate: -2, title: "x".repeat(900) });
  assert.equal(kept.artworkUrl, null);
  assert.equal(kept.duration, null);
  assert.equal(kept.position, 0);
  assert.equal(kept.rate, 0);
  assert.equal(kept.title.length, 200);
});

test("the most recently started media is in front, playing or paused, like the Mac's card", () => {
  const shelf = { a: media("a", { startedAt: 100 }), b: media("b", { startedAt: 300, state: "paused" }), c: media("c", { startedAt: 200 }) };
  assert.equal(frontMedia(shelf)?.pageId, "b");
  assert.equal(frontMedia(shelf, (one) => one.pageId !== "b")?.pageId, "c");
  assert.equal(frontMedia({}), null);
});

test("the mini player shows when the playing tab is not the one on screen", () => {
  const playing = media("a");
  assert.equal(miniPlayerShows(playing, scene()), true);
  assert.equal(miniPlayerShows(playing, scene({ surface: "deck", selectedId: "a" })), true);
  assert.equal(miniPlayerShows(playing, scene({ surface: "start", selectedId: "a" })), true);
  assert.equal(miniPlayerShows(playing, scene({ selectedId: "a" })), false);
});

test("it stays away while search, a menu or a sheet covers the screen, with the setting off, or once the tab is gone", () => {
  const playing = media("a");
  assert.equal(miniPlayerShows(playing, scene({ covered: true })), false);
  assert.equal(miniPlayerShows(playing, scene({ enabled: false })), false);
  assert.equal(miniPlayerShows(playing, scene({ tabExists: false })), false);
  assert.equal(miniPlayerShows(null, scene()), false);
});

test("Incognito media shows only on the Incognito side and other media only on the other", () => {
  assert.equal(miniPlayerShows(media("a", { isPrivate: true }), scene()), false);
  assert.equal(miniPlayerShows(media("a", { isPrivate: true }), scene({ incognito: true })), true);
  assert.equal(miniPlayerShows(media("a"), scene({ incognito: true })), false);
});

test("closing it hides it for that playing session only, and a new start brings it back", () => {
  const playing = media("a", { startedAt: 500 });
  assert.equal(miniPlayerShows(playing, scene({ dismissed: { pageId: "a", startedAt: 500 } })), false);
  assert.equal(miniPlayerShows(media("a", { startedAt: 900 }), scene({ dismissed: { pageId: "a", startedAt: 500 } })), true);
  assert.equal(miniPlayerShows(media("b", { startedAt: 500 }), scene({ dismissed: { pageId: "a", startedAt: 500 } })), true);
});

test("skip buttons use the site's previous and next tracks when it has them, else the chosen seconds, and none for live streams", () => {
  assert.deepEqual(skipControls({ canPrevious: false, canNext: false, duration: 600 }, 15), { back: { kind: "seconds", seconds: -15 }, forward: { kind: "seconds", seconds: 15 } });
  assert.deepEqual(skipControls({ canPrevious: true, canNext: true, duration: 600 }, 30), { back: { kind: "track", command: "previous" }, forward: { kind: "track", command: "next" } });
  assert.deepEqual(skipControls({ canPrevious: false, canNext: true, duration: null }, 10), { back: null, forward: { kind: "track", command: "next" } });
});

test("the position moves on at the playback rate while playing and stops at the end", () => {
  const playing = media("a", { position: 10, at: 0, rate: 2, duration: 30 });
  assert.equal(positionAt(playing, 5_000), 20);
  assert.equal(positionAt(playing, 60_000), 30);
  assert.equal(positionAt({ ...playing, state: "paused" }, 60_000), 10);
});

test("a press answers at once: the button flips before the page reports back", () => {
  const playing = media("a", { position: 10, at: 0, rate: 1 });
  const paused = withOptimisticState(playing, "paused", 4_000);
  assert.equal(paused.state, "paused");
  assert.equal(paused.position, 14);
  assert.equal(withOptimisticState(paused, "paused", 9_000), paused);
});

test("the lines show the media title and artist, falling back to the tab title and the site", () => {
  assert.deepEqual(miniPlayerLines({ title: "Song", artist: "Band" }, "Tab", "music.example.com"), { title: "Song", detail: "Band" });
  assert.deepEqual(miniPlayerLines({ title: "", artist: "" }, "Tab title", "m.youtube.com"), { title: "Tab title", detail: "m.youtube.com" });
  assert.deepEqual(miniPlayerLines({ title: "", artist: "" }, "  ", "m.youtube.com"), { title: "m.youtube.com", detail: "m.youtube.com" });
  assert.deepEqual(miniPlayerLines({ title: "Same", artist: "Same" }, "Tab", "site.com"), { title: "Same", detail: "site.com" });
});

test("PlayingMedia never carries a page address", () => {
  const keys = Object.keys(media("a")) as (keyof PlayingMedia)[];
  assert.equal(keys.some((key) => /url$/i.test(key) && key !== "artworkUrl"), false);
});
