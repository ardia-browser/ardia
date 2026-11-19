import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port } from "./engineAutoplayKit";
import { evaluate, firstWindow, listed, pause, until } from "./engineSleep";
import { SONG, TITLE, command, isPaused, isPlaying, mediaState, pageState, pausePage, reported, reportsOf, startPlaying, withReports, type NowPlaying, type Reports } from "./engineNowPlayingKit";

const TRACK_SECONDS = 30;
const PLAY_FROM = 27;
const AT_END_SLACK = 1;
const RESTARTED_BY = 3;
const STILL_PAUSED_MS = 1500;
const SHORT_SOUND_SETTLES_MS = 1500;
const NEXT_TITLE = "Next Song";
const LAST_TITLE = "Last Song";
const MUTE_SETTLES_MS = 1000;

type Focus = { held?: boolean; type?: string; state?: string; requests?: number };

const focusOf = async (key: string) => ((await hostCall<Focus>("tab.call", { key, method: "audioFocusForTest" })) ?? {}) as Focus;
const focusShape = (focus: Focus) => ({ held: focus.held ?? null, type: focus.type ?? null, state: focus.state ?? null });
const positionOf = (state: NowPlaying | null | undefined) => ({ playbackState: state?.playbackState ?? null, position: state?.position ?? null, duration: state?.duration ?? null });
const atEnd = (state: NowPlaying | null | undefined) => Math.abs((state?.position ?? 0) - TRACK_SECONDS) <= AT_END_SLACK && Math.abs((state?.duration ?? 0) - TRACK_SECONDS) <= AT_END_SLACK;
const restarted = (state: NowPlaying | null | undefined) => isPlaying(state) && (state?.position ?? Infinity) < RESTARTED_BY;

async function playedToEnd(key: string, reports: Reports) {
  await until(`the ${TRACK_SECONDS} s track's length is known`, SETTLE_MS, () => mediaState(key), (state) => typeof state.duration === "number" && Math.abs(state.duration - TRACK_SECONDS) < AT_END_SLACK);
  await evaluate(key, `m.currentTime = ${PLAY_FROM}; post("result", "true");`);
  await startPlaying(key);
  await reported(reports, "the page reports playing", isPlaying);
  await until("the track plays to its end", SETTLE_MS, () => pageState(key), (state) => state.ended === true);
  return reported(reports, "the ended track is reported paused at its end", (state) => isPaused(state) && atEnd(state));
}

async function endsAndStartsAgain(key: string, reports: Reports, title: string | undefined) {
  const ended = await playedToEnd(key, reports);
  await pause(STILL_PAUSED_MS);
  const later = await reports.latest();
  expectEqual({ paused: isPaused(later), atEnd: atEnd(later), title: later?.title || undefined }, { paused: true, atEnd: true, title }, `the ended track is still reported paused at its end ${STILL_PAUSED_MS} ms later (${JSON.stringify(positionOf(later))})`);
  const from = reports.reports.length;
  await command(key, "play");
  const again = await reported(reports, "the card's play starts the track again from the start", restarted);
  const firstPlaying = reports.reports.slice(from).find(isPlaying);
  const page = await pageState(key);
  console.info(`[ardia windows] self-check note: ended track reported ${JSON.stringify(positionOf(ended))}, ${STILL_PAUSED_MS} ms later ${JSON.stringify(positionOf(later))}; after the card's play the first playing report ${JSON.stringify(positionOf(firstPlaying))}, then ${JSON.stringify(positionOf(again))}; the page's own time ${page.time}`);
  expectTrue(typeof page.time === "number" && page.time < RESTARTED_BY + 1 && page.paused === false, `the page plays again from the start (${JSON.stringify(page)})`);
}

async function switchedTrack(key: string, reports: Reports, title: string, query: string) {
  const from = reports.reports.length;
  const started = await evaluate(
    key,
    `navigator.mediaSession.metadata = new MediaMetadata({ title: ${JSON.stringify(title)}, artist: "Ardia Band", album: "Ardia Album" }); m.loop = false; m.src = "/tone.wav?long&${query}"; m.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));`,
    true,
  );
  expectEqual(started, "played", `the page plays ${title} on the same element`);
  const playing = await reported(reports, `${title} is reported playing`, (state) => isPlaying(state) && state?.title === title);
  expectTrue(playing?.controllable === true, `${title} is controllable, so the card shows it (${JSON.stringify(playing)})`);
  return reports.reports.slice(from).filter((state) => state === null).length;
}

const followsThePlayingOne = (state: NowPlaying | null | undefined) => isPlaying(state) && Math.abs((state?.duration ?? 0) - TRACK_SECONDS) <= AT_END_SLACK && (state?.position ?? Infinity) < PLAY_FROM;

const endedChecks: Check[] = [
  {
    name: "engine now playing: with two players, a track that ends while the other plays stays out of the session through a mute toggle, and the card follows the one still playing",
    run: () =>
      withReports("np-ended-two", "nowplaying?plain&second&long", TITLE, async (key, reports) => {
        expectEqual(await evaluate(key, 'n.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true), "played", "the other player plays with sound first");
        await until(`the ${TRACK_SECONDS} s track's length is known`, SETTLE_MS, () => mediaState(key), (state) => typeof state.duration === "number" && Math.abs(state.duration - TRACK_SECONDS) < AT_END_SLACK);
        await evaluate(key, `m.currentTime = ${PLAY_FROM}; post("result", "true");`);
        await startPlaying(key);
        await until("the first track plays to its end while the other plays", SETTLE_MS, () => pageState(key), (state) => state.ended === true);
        const following = await reported(reports, "the card follows the player still playing, with its own length and position", followsThePlayingOne);
        const before = await focusOf(key);
        await hostCall("tab.call", { key, method: "setMuted", muted: true });
        await pause(MUTE_SETTLES_MS);
        await hostCall("tab.call", { key, method: "setMuted", muted: false });
        await pause(MUTE_SETTLES_MS);
        const after = await focusOf(key);
        const last = await reports.latest();
        console.info(`[ardia windows] self-check note: two players, one ended: before the mute toggle ${JSON.stringify(positionOf(following))} focus ${JSON.stringify(before)}; after it ${JSON.stringify(positionOf(last))} focus ${JSON.stringify(after)}`);
        expectTrue(followsThePlayingOne(last), `after the mute toggle the card still follows only the player still playing, so the ended one was not added back (${JSON.stringify(positionOf(last))})`);
        expectEqual({ held: after.held ?? null, requests: after.requests ?? null }, { held: true, requests: before.requests ?? null }, "the audio focus requests did not grow with the mute toggle");
      }),
  },
  {
    name: "engine now playing: a track that plays to its end stays reported paused at its end, as on the Mac, and the card's play starts it again from the start (page handles play)",
    run: () => withReports("np-ended", "nowplaying?long&once", TITLE, (key, reports) => endsAndStartsAgain(key, reports, SONG.title)),
  },
  {
    name: "engine now playing: a track with no media session handlers that plays to its end stays reported paused at its end, under the document's title as Chromium fills it, and the card's play starts it again from the start",
    run: () => withReports("np-ended-plain", "nowplaying?plain&long&once", TITLE, (key, reports) => endsAndStartsAgain(key, reports, TITLE)),
  },
  {
    name: "engine now playing: a two-second sound that plays and ends leaves no card and no audio focus behind",
    run: () =>
      withReports("np-short-sound", "nowplaying?plain&once", TITLE, async (key, reports) => {
        await startPlaying(key);
        await until("the two-second sound ends", SETTLE_MS, () => pageState(key), (state) => state.ended === true);
        await pause(SHORT_SOUND_SETTLES_MS);
        const focus = await focusOf(key);
        const last = (await reports.latest()) ?? null;
        console.info(`[ardia windows] self-check note: a two-second sound sent ${reports.reports.length} nowPlaying reports (${JSON.stringify(reports.reports.map((state) => (state ? `${state.playbackState}${state.controllable ? " controllable" : ""}` : null)))}); its audio focus after the end ${JSON.stringify(focus)}`);
        expectEqual(
          { controllable: reports.reports.filter((state) => state?.controllable === true).length, last, focusHeld: focus.held ?? null },
          { controllable: 0, last: null, focusHeld: false },
          "no report the card would show, no session left after the end, and no audio focus request left",
        );
      }),
  },
  {
    name: "engine now playing: an ended track holds the same audio focus request as an ordinarily paused track, no more",
    run: () =>
      withReports("np-ended-focus", "nowplaying?long&once", TITLE, (ended, endedReports) =>
        withReports("np-paused-focus", "nowplaying?long", TITLE, async (paused, pausedReports) => {
          await playedToEnd(ended, endedReports);
          await startPlaying(paused);
          await reported(pausedReports, "the other tab reports playing", isPlaying);
          await pausePage(paused);
          await reported(pausedReports, "the other tab reports paused", isPaused);
          const endedFocus = await focusOf(ended);
          const pausedFocus = await focusOf(paused);
          const endedStill = await endedReports.latest();
          console.info(`[ardia windows] self-check note: audio focus of an ended track ${JSON.stringify(endedFocus)}, of a paused track ${JSON.stringify(pausedFocus)}`);
          expectEqual(focusShape(endedFocus), focusShape(pausedFocus), "the ended track's audio focus request matches the paused track's");
          expectEqual(focusShape(endedFocus), { held: true, type: "gain", state: "suspended" }, "both hold a suspended request, as Chromium keeps for any paused track");
          expectTrue(isPaused(endedStill) && atEnd(endedStill), `the ended track is still reported paused at its end after the other tab played (${JSON.stringify(positionOf(endedStill))})`);
        }),
      ),
  },
  {
    name: "engine now playing: an ended track's session ends once the page drops its media",
    run: () =>
      withReports("np-ended-drop", "nowplaying?long&once", TITLE, async (key, reports) => {
        await playedToEnd(key, reports);
        await evaluate(key, 'm.removeAttribute("src"); m.load(); post("result", "true");');
        await reported(reports, "the session ends once the page drops its media", (now) => now === null);
        expectEqual((await focusOf(key)).held ?? null, false, "no audio focus request is left");
      }),
  },
  {
    name: "engine now playing: an ended track's session ends when the page navigates away",
    run: () =>
      withReports("np-ended-navigate", "nowplaying?long&once", TITLE, async (key, reports) => {
        await playedToEnd(key, reports);
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/a` });
        await until("the next page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === "loaded a");
        await reported(reports, "the session ends with the page", (now) => now === null);
      }),
  },
  {
    name: "engine now playing: an ended track's session ends when the tab closes",
    run: async () => {
      const key = "self-check-np-ended-close";
      const reports = reportsOf(key);
      const windowId = await firstWindow();
      try {
        await hostCall("tab.create", { key, url: `${origin}/nowplaying?long&once`, profile: "" }, windowId);
        await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false);
        await playedToEnd(key, reports);
        await hostCall("tab.close", { key });
        await reported(reports, "the session ends with the tab", (now) => now === null);
      } finally {
        reports.stop();
        await hostCall("tab.close", { key }).catch(() => null);
      }
    },
  },
  {
    name: "engine now playing: a page that reuses an ended track's element for the next track carries on, as after a paused track (gaps logged)",
    run: () =>
      withReports("np-ended-next", "nowplaying?long&once", TITLE, async (key, reports) => {
        await playedToEnd(key, reports);
        const afterEnded = await switchedTrack(key, reports, NEXT_TITLE, "next");
        await pausePage(key);
        await reported(reports, `${NEXT_TITLE} is reported paused`, (state) => isPaused(state) && state?.title === NEXT_TITLE);
        const afterPaused = await switchedTrack(key, reports, LAST_TITLE, "last");
        console.info(`[ardia windows] self-check note: reports with no session while the page switched tracks on one element: ${afterEnded} after an ended track, ${afterPaused} after a paused one (a new src replaces Chromium's player, so a short gap is Chromium's own)`);
      }),
  },
];

export const checks: Check[] = port ? endedChecks : [];
