import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { SETTLE_MS, port, restore, setAutoplay } from "./engineAutoplayKit";
import { evaluate, listed, pause, until } from "./engineSleep";
import { TITLE, called, command, commandAnswer, isPaused, isPlaying, pageState, pausePage, projected, reported, startPlaying, unaskedPlay, withReports, type Reports } from "./engineNowPlayingKit";

const SKIP_SECONDS = 15;
const SEEK_SLACK = 1.5;
const FORCED_REPORT_MS = 2500;
const TINY_SECONDS = 1e-9;

async function playsAfterBlock(name: string, path: string) {
  try {
    await withReports(name, path, TITLE, async (key, reports) => {
      await until("the unrelated cross-site ad iframe reports", SETTLE_MS, () => pageState(key), (state) => state.ad?.active === false);
      await startPlaying(key);
      await reported(reports, "the page reports playing", isPlaying);
      await setAutoplay("block");
      await until("blocking autoplay pauses the media the user did not ask for", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
      await reported(reports, "the paused media is reported paused", isPaused);
      await command(key, "play");
      await until("the card's play plays it on the blocked site", SETTLE_MS, () => pageState(key), (state) => state.paused === false && (state.time ?? 0) > 0);
      await reported(reports, "the page reports playing again", isPlaying);
      await pause(500);
      expectEqual((await pageState(key)).ad?.active, false, "the unrelated cross-site ad iframe's navigator.userActivation.hasBeenActive after the card's play");
      await evaluate(key, 'document.querySelector("iframe").contentWindow.postMessage("np-try-muted", "*"); post("result", "true");');
      const tried = await until("the unrelated ad iframe tries a muted play()", SETTLE_MS, () => pageState(key), (state) => typeof state.ad?.tried === "string");
      expectEqual(tried.ad?.tried, "NotAllowedError", "a muted play() in the unrelated cross-site ad iframe after the card's play, on the blocked site");
    });
  } finally {
    await restore();
  }
}

async function blockedAndPaused(key: string, reports: Reports) {
  await startPlaying(key);
  await reported(reports, "the page reports playing", isPlaying);
  await pausePage(key);
  await reported(reports, "the page reports paused", isPaused);
  await setAutoplay("block");
  await pause(500);
}

const asksChecks: Check[] = [
  {
    name: "engine now playing: on a blocked site, the card's play reaches the page's play handler, and an unrelated cross-site ad iframe gains no user activation",
    run: () => playsAfterBlock("np-blocked", "nowplaying?withad"),
  },
  {
    name: "engine now playing: on a blocked site, the card's play plays a page without action handlers, and an unrelated cross-site ad iframe gains no user activation",
    run: () => playsAfterBlock("np-blocked-bare", "nowplaying?withad&bare"),
  },
  {
    name: "engine now playing: on a blocked site, Next the page does not handle is refused and is not the user asking, and Previous it handles is",
    run: async () => {
      try {
        await withReports("np-asks-tracks", "nowplaying?prevonly", TITLE, async (key, reports) => {
          await blockedAndPaused(key, reports);
          expectEqual(await commandAnswer(key, "next"), "refused", "the app's Next on a page with no nexttrack handler");
          await pause(500);
          expectEqual(await unaskedPlay(key), "NotAllowedError", "a later play() the user did not ask for, after the unhandled Next");
          expectEqual(await commandAnswer(key, "previous"), "done", "the app's Previous on a page with a previoustrack handler");
          await called(key, "previoustrack", "the page's previoustrack handler runs");
          expectEqual(await unaskedPlay(key), "played", "a play() after the handled Previous, the user's ask");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine now playing: on a blocked site, a seek the page handles is not the user asking",
    run: async () => {
      try {
        await withReports("np-asks-seek", "nowplaying?seekonly", TITLE, async (key, reports) => {
          await blockedAndPaused(key, reports);
          expectEqual(await commandAnswer(key, "seekTo", 1), "done", "the app's seekTo");
          await called(key, "seekto:1", "the page's seekto handler runs");
          expectEqual(await unaskedPlay(key), "NotAllowedError", "a later play() the user did not ask for, after the seek");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine now playing: a skip on a page that handles seekto lands 15 s past the last report through its seekto handler",
    run: () =>
      withReports("np-skip-seekto", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        const last = await reported(reports, "the page reports playing with its position", (now) => isPlaying(now) && now?.duration === 120);
        const expected = projected(last!) + SKIP_SECONDS;
        await command(key, "seekBy", SKIP_SECONDS);
        const state = await until("the page's seekto handler runs", SETTLE_MS, () => pageState(key), (now) => !!now.calls?.some((call) => call.startsWith("seekto:")));
        const time = Number(state.calls!.find((call) => call.startsWith("seekto:"))!.slice("seekto:".length));
        expectTrue(Math.abs(time - expected) < SEEK_SLACK, `the seekto handler's details.seekTime ${time} is the last report plus ${SKIP_SECONDS} s (${expected.toFixed(2)})`);
      }),
  },
  {
    name: "engine now playing: a skip on a page that handles only seekforward reaches that handler, and a report follows so the card drops its guess",
    run: () =>
      withReports("np-skip-forward", "nowplaying?fwdonly", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await pause(500);
        const before = reports.reports.length;
        await command(key, "seekBy", SKIP_SECONDS);
        await until("the page's seekforward handler runs", SETTLE_MS, () => pageState(key), (now) => !!now.calls?.some((call) => call.startsWith("seekforward")));
        await until("a report follows the relative seek", FORCED_REPORT_MS, async () => reports.reports.length, (count) => count > before);
      }),
  },
  {
    name: "engine now playing: a skip too small to be any time is refused, and the engine stays up",
    run: () =>
      withReports("np-skip-tiny", "nowplaying?bare", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        expectEqual(await commandAnswer(key, "seekBy", TINY_SECONDS), "refused", `seekBy ${TINY_SECONDS}`);
        await pause(500);
        expectEqual((await listed(key))?.title, TITLE, "the engine still answers for the tab");
        expectEqual(await hostCall("tab.call", { key, method: "mediaCommand", action: "pause", seconds: null }).then(() => "done"), "done", "the engine still takes media commands");
      }),
  },
];

export const checks: Check[] = port ? asksChecks : [];
