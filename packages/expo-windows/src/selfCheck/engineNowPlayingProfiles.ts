import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port } from "./engineAutoplayKit";
import { evaluate, firstWindow, hide, LEFT, listed, show, until } from "./engineSleep";
import { SONG, TITLE, called, command, commandReply, downloaded, expectPng, isPaused, isPlaying, pageState, reported, reportsOf, startPlaying } from "./engineNowPlayingKit";

const OTHER_PROFILE = "self-check-np-other-profile";
const SEEK_TO = 42;

type Answer = { ok?: boolean; done?: boolean; byScript?: boolean };

const answerOf = async (key: string, action: string) => {
  const reply = await commandReply(key, action);
  if (reply.startsWith("refused")) return { refused: reply };
  const parsed = JSON.parse(reply) as Answer;
  return { ok: parsed.ok, done: parsed.done, byScript: parsed.byScript };
};

async function inOtherProfile(name: string, path: string, run: (key: string, windowId: string) => Promise<void>) {
  const key = `self-check-np-profiles-${name}`;
  const windowId = await firstWindow();
  try {
    await hostCall("tab.create", { key, url: `${origin}/${path}`, profile: OTHER_PROFILE }, windowId);
    await until(`the page ${key} loads in another profile`, LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false);
    await show(key, windowId, LEFT);
    await run(key, windowId);
  } finally {
    await hostCall("tab.close", { key }).catch(() => null);
  }
}

const profileChecks: Check[] = [
  {
    name: "engine now playing: a card showing another profile's tab reaches that tab: pause, play, seek, next, previous and its artwork",
    run: () =>
      inOtherProfile("commands", "nowplaying?long", async (key) => {
        const reports = reportsOf(key);
        try {
          await startPlaying(key);
          const playing = await reported(reports, "the other profile's tab reports playing", isPlaying);
          expectEqual(playing?.title, SONG.title, "the other profile's song is reported");
          await command(key, "pause");
          await until("the card's pause reaches the other profile's tab", SETTLE_MS, () => pageState(key), (state) => state.paused === true);
          await reported(reports, "the other profile's tab reports paused", isPaused);
          await command(key, "play");
          await until("the card's play reaches it", SETTLE_MS, () => pageState(key), (state) => state.paused === false);
          await command(key, "seekTo", SEEK_TO);
          await called(key, `seekto:${SEEK_TO}`, "the card's seek reaches the page's handler");
          await command(key, "next");
          await called(key, "nexttrack", "the card's next reaches the page's handler");
          await command(key, "previous");
          await called(key, "previoustrack", "the card's previous reaches the page's handler");
          const withArt = await reported(reports, "the other profile's tab reports its artwork", (state) => typeof state?.artwork === "string" && state.artwork.length > 0);
          expectPng(await downloaded(key, withArt!.artwork!), "the other profile's artwork, downloaded in that tab's own profile");
        } finally {
          reports.stop();
        }
      }),
  },
  {
    name: "engine now playing: a sleeping tab of another profile woken to play plays through its own wake allowance",
    run: () =>
      inOtherProfile("wake", "nowplaying?plain&long&wake", async (key, windowId) => {
        await hide(key, windowId);
        expectEqual((await hostCall<{ outcome?: unknown }>("tab.call", { key, method: "discard" })).outcome, "discarded", "the other profile's hidden page is discarded");
        await hostCall("tab.call", { key, method: "reloadToPlay" });
        await until("the woken page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false && tab.discarded !== true);
        expectEqual(await answerOf(key, "play"), { ok: true, done: true, byScript: true }, "the first play after the wake");
        const media = await until("the woken page plays", SETTLE_MS, () => evaluate(key, 'post("result", JSON.stringify({ paused: m.paused }));') as Promise<{ paused?: boolean } | null>, (state) => state?.paused === false);
        expectTrue(media?.paused === false, "the other profile's woken page plays");
      }),
  },
];

export const checks: Check[] = port ? profileChecks : [];
