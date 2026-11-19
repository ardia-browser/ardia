import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port } from "./engineAutoplayKit";
import { evaluate, firstWindow, LEFT, listed, pause, show, until } from "./engineSleep";
import { FRAME_TITLE, SONG, TITLE, called, playFrame, command, commandReply, downloaded, expectPng, isPaused, isPlaying, mediaState, pageState, pausePage, reported, reportsOf, startPlaying, withReports, type Reports } from "./engineNowPlayingKit";

const PAGE_ACTIONS = ["play", "pause", "nexttrack", "previoustrack", "seekto"];
const DECLARED_DURATION = 120;
const SEEK_TO = 42;
const STEADY_MS = 10000;
const MOST_STEADY_REPORTS = 5;
const BURST_LAST = { title: "Burst 999", position: 99.9 };
const MOST_BURST_REPORTS = 15;
const BURST_MS = 5000;
const REWIND_SETTLES_MS = 1000;
const FLAP_MS = 5000;
const MOST_FLAP_REPORTS = 15;
const REPORT_WINDOW_MS = 100;
const HELD_PAUSE_MS = 400;

async function flapped(key: string) {
  await evaluate(key, 'flap(); post("result", "true");');
  await until("the page finishes flapping", FLAP_MS, () => evaluate(key, 'post("result", JSON.stringify(window.flapDone));'), (done) => done === true);
}

async function flapsAround(key: string, reports: Reports) {
  await startPlaying(key);
  await reported(reports, "the page reports playing", isPlaying);
  await pause(500);
  const before = reports.reports.length;
  await flapped(key);
  const held = reports.reports.length;
  await pausePage(key);
  await pause(HELD_PAUSE_MS);
  const duringPause = reports.reports.slice(held);
  expectTrue(duringPause.some(isPaused), `a pause held ${HELD_PAUSE_MS} ms, past the ${REPORT_WINDOW_MS} ms report window, between two flaps is reported (${JSON.stringify(duringPause.map((report) => report?.playbackState ?? null))})`);
  await flapped(key);
  await pause(500);
  const sent = reports.reports.length - before;
  console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports for two bursts of 200 pause and play changes with a held pause between`);
  expectTrue(sent <= MOST_FLAP_REPORTS * 2, `at most ${MOST_FLAP_REPORTS * 2} reports for the two flaps, got ${sent}`);
  const state = await pageState(key);
  expectEqual({ paused: state.paused, reported: (await reports.latest())?.playbackState }, { paused: false, reported: "playing" }, "the page ends playing and the last report says so");
}

const nowPlayingChecks: Check[] = [
  {
    name: "engine now playing: a page flapping pause and play 200 times in a second sends about ten reports, the last with its true state",
    run: () =>
      withReports("np-flap", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await pause(500);
        const before = reports.reports.length;
        await flapped(key);
        await pause(500);
        const sent = reports.reports.length - before;
        console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports for 200 pause and play changes in a second`);
        expectTrue(sent <= MOST_FLAP_REPORTS, `at most ${MOST_FLAP_REPORTS} reports for the flapping, got ${sent}`);
        const state = await pageState(key);
        expectEqual({ paused: state.paused, reported: (await reports.latest())?.playbackState }, { paused: false, reported: "playing" }, "the page ends playing and the last report says so");
      }),
  },
  {
    name: "engine now playing: a pause held past the report window between two bursts of flapping is reported, and the last report is the true state",
    run: () => withReports("np-flap-held", "nowplaying?long", TITLE, flapsAround),
  },
  {
    name: "engine now playing: a playing page reports its Media Session metadata, playing, controllable and its actions, and only its declared artwork downloads, as a PNG",
    run: () =>
      withReports("np-report", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page's session is reported playing with its declared duration and artwork", (now) => isPlaying(now) && now?.title === SONG.title && now?.duration === DECLARED_DURATION && !!now?.artwork);
        expectEqual({ title: state?.title, artist: state?.artist, album: state?.album }, SONG, "the reported metadata");
        expectEqual({ controllable: state?.controllable, hasVideo: state?.hasVideo, loop: state?.loop }, { controllable: true, hasVideo: false, loop: false }, "controllable audio, loop not guessed");
        expectEqual(PAGE_ACTIONS.filter((action) => !state?.actions?.includes(action)), [], `the page's action handlers among the actions ${JSON.stringify(state?.actions)}`);
        expectEqual(state?.artwork, `${origin}/art.png`, "the artwork is the largest declared size, as on the Mac");
        expectPng(await downloaded(key, state!.artwork!), "the 300 px PNG artwork, asked for at 256 px");
        expectEqual((await downloaded(key, `${origin}/art.png?undeclared`))?.uri ?? null, null, "an image the session did not declare is not downloaded");
        expectEqual((await downloaded(key, "file:///C:/Windows/win.ini"))?.uri ?? null, null, "a file URL is not downloaded");
      }),
  },
  {
    name: "engine now playing: pause, play, next, previous and seek from the app reach the page's Media Session handlers",
    run: () =>
      withReports("np-commands", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await command(key, "pause");
        await called(key, "pause", "the page's pause handler runs");
        await until("the page pauses", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
        await reported(reports, "the page reports paused", isPaused);
        await command(key, "play");
        await called(key, "play", "the page's play handler runs");
        await until("the page plays again", SETTLE_MS, () => pageState(key), (state) => state.paused === false);
        await reported(reports, "the page reports playing again", isPlaying);
        await command(key, "next");
        await called(key, "nexttrack", "the page's nexttrack handler runs");
        await command(key, "previous");
        await called(key, "previoustrack", "the page's previoustrack handler runs");
        await command(key, "seekTo", SEEK_TO);
        await called(key, `seekto:${SEEK_TO}`, "the page's seekto handler runs with the time asked for");
        await reported(reports, "the reported position moves to the seek", (now) => Math.abs((now?.position ?? 0) - SEEK_TO) < 3);
      }),
  },
  {
    name: "engine now playing: on a page without action handlers, pause, play and seekTo from the app reach its media through the session",
    run: () =>
      withReports("np-bare", "nowplaying?bare", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await command(key, "pause");
        await until("the media pauses", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
        await reported(reports, "the page reports paused", isPaused);
        const answer = await commandReply(key, "seekTo", 1);
        await until(`the media seeks to 1 s (mediaCommand answered ${answer}; seekable, readyState and duration below)`, SETTLE_MS, () => mediaState(key), (state) => Math.abs((state.time ?? -1) - 1) < 0.3);
        await command(key, "play");
        await until("the media plays again", SETTLE_MS, () => pageState(key), (state) => state.paused === false);
        expectEqual((await pageState(key)).calls?.filter((call) => !call.startsWith("play:")) ?? [], [], "no page handler was involved");
      }),
  },
  {
    name: "engine now playing: media in a cross-site iframe is reported and obeys play and pause from the app",
    run: () =>
      withReports("np-framed", "npframe", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe's session is reported playing", (now) => isPlaying(now) && now?.title === SONG.title);
        expectEqual(state?.controllable, true, "the iframe's media is controllable");
        await command(key, "pause");
        await until("the app's pause reaches the iframe's handler", SETTLE_MS, () => pageState(key), (now) => now.frame?.paused === true && !!now.frame.calls?.includes("pause"));
        await reported(reports, "the iframe reports paused", isPaused);
        await command(key, "play");
        await until("the app's play reaches the iframe's handler", SETTLE_MS, () => pageState(key), (now) => now.frame?.paused === false && !!now.frame.calls?.includes("play"));
        await reported(reports, "the iframe reports playing again", isPlaying);
      }),
  },
  {
    name: "engine now playing: a cross-site iframe's song stays on the card, controllable, while the tab is muted, and follows the session again once unmuted",
    run: () =>
      withReports("np-framed-muted", "npframe", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        await reported(reports, "the iframe's session is reported playing and controllable", (now) => isPlaying(now) && now?.controllable === true);
        await hostCall("tab.call", { key, method: "setMuted", muted: true });
        await pause(1000);
        const muted = await reports.latest();
        expectEqual({ title: muted?.title, playing: isPlaying(muted), controllable: muted?.controllable }, { title: SONG.title, playing: true, controllable: true }, "the muted tab keeps its card's track, playing and controllable");
        await command(key, "pause");
        await until("the card's pause reaches the muted tab's cross-site song", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === true);
        await command(key, "play");
        await until("the card's play reaches it again", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === false);
        await hostCall("tab.call", { key, method: "setMuted", muted: false });
        const back = await reported(reports, "the unmuted tab's song follows its session again", (now) => isPlaying(now) && now?.controllable === true && !!now.actions?.includes("pause"));
        expectTrue(!!back?.actions?.includes("play"), `the session's actions again: ${JSON.stringify(back)}`);
      }),
  },
  {
    name: "engine now playing: a page that seeks its own track back to the start is not reported as looping",
    run: () =>
      withReports("np-rewind", "nowplaying?plain&long&rewind", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await until("the page seeks itself back to the start near the end", SETTLE_MS, () => evaluate(key, 'post("result", JSON.stringify(window.rewound));'), (rewound) => rewound === true);
        await pause(REWIND_SETTLES_MS);
        expectEqual(reports.reports.filter((report) => report?.loop === true).length, 0, "reports marked loop after the page's own seek back");
      }),
  },
  {
    name: "engine now playing: the session ends when the page navigates away",
    run: () =>
      withReports("np-navigate", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/a` });
        await until("the next page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === "loaded a");
        await reported(reports, "the session ends with the page", (now) => now === null);
      }),
  },
  {
    name: "engine now playing: the session ends when the tab closes",
    run: async () => {
      const key = "self-check-np-close";
      const reports = reportsOf(key);
      const windowId = await firstWindow();
      try {
        await hostCall("tab.create", { key, url: `${origin}/nowplaying`, profile: "" }, windowId);
        await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false);
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await hostCall("tab.close", { key });
        await reported(reports, "the session ends with the tab", (now) => now === null);
      } finally {
        reports.stop();
        await hostCall("tab.close", { key }).catch(() => null);
      }
    },
  },
  {
    name: "engine now playing: steady playback sends few reports",
    run: () =>
      withReports("np-steady", "nowplaying?plain&long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await pause(1000);
        const before = reports.reports.length;
        await pause(STEADY_MS);
        const sent = reports.reports.length - before;
        console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports over ${STEADY_MS / 1000} s of steady playback`);
        expectTrue(sent <= MOST_STEADY_REPORTS, `at most ${MOST_STEADY_REPORTS} reports over ${STEADY_MS / 1000} s of steady playback, got ${sent}`);
        expectEqual(isPlaying(await reports.latest()), true, "the track is still reported playing");
      }),
  },
  {
    name: "engine now playing: a page changing its metadata and position 1,000 times in a second sends about ten reports, the last with its final state",
    run: () =>
      withReports("np-burst", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", (now) => isPlaying(now) && now?.title === SONG.title);
        await pause(500);
        const before = reports.reports.length;
        await evaluate(key, 'burst(); post("result", "true");');
        await until("the page finishes its burst", BURST_MS, () => pageState(key), (state) => state.burstDone === true);
        await pause(500);
        const sent = reports.reports.length - before;
        console.info(`[ardia windows] self-check note: ${sent} nowPlaying reports for 1,000 metadata and position changes`);
        expectTrue(sent <= MOST_BURST_REPORTS, `at most ${MOST_BURST_REPORTS} reports for the burst, got ${sent}`);
        const last = await reports.latest();
        expectEqual(last?.title, BURST_LAST.title, "the last report carries the final title");
        expectTrue(Math.abs((last?.position ?? 0) - BURST_LAST.position) < 1.5, `the last report carries the final position ${BURST_LAST.position}: ${last?.position}`);
      }),
  },
];

export const checks: Check[] = port ? nowPlayingChecks : [];
