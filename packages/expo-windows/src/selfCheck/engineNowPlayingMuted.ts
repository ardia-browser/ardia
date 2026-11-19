import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { SETTLE_MS, port } from "./engineAutoplayKit";
import { evaluate, pause, until } from "./engineSleep";
import { FRAME_TITLE, SONG, TITLE, command, commandReply, isPaused, isPlaying, pageState, pausePage, playFrame, reported, startPlaying, withReports, type PageState, type Reports } from "./engineNowPlayingKit";

const SEEK_TO = 42;
const MUTE_SETTLES_MS = 1000;
const NOTHING_PLAYS_MS = 1500;

type Where = { name: string; calls: (state: PageState) => string[] | undefined; paused: (state: PageState) => boolean | null | undefined };

const MAIN: Where = { name: "the page", calls: (state) => state.calls, paused: (state) => state.paused };
const FRAME: Where = { name: "the cross-site iframe", calls: (state) => state.frame?.calls, paused: (state) => state.frame?.paused };

const mute = (key: string) => hostCall("tab.call", { key, method: "setMuted", muted: true });
const playing = async (key: string, element: string) => (await evaluate(key, `post("result", JSON.stringify(!${element}.paused));`)) === true;

async function mutedAndStillShown(key: string, reports: Reports, where: Where) {
  await reported(reports, `${where.name}: the song is reported playing and controllable`, (now) => isPlaying(now) && now?.controllable === true);
  await mute(key);
  await pause(MUTE_SETTLES_MS);
  const muted = await reports.latest();
  expectEqual({ title: muted?.title, playing: isPlaying(muted), controllable: muted?.controllable }, { title: SONG.title, playing: true, controllable: true }, `${where.name}: the muted tab keeps its card, playing and controllable`);
}

async function obeysWhileMuted(key: string, reports: Reports, where: Where) {
  await mutedAndStillShown(key, reports, where);
  const handled = (call: string) => until(`${where.name}: the page's ${call} handler runs in the muted tab`, SETTLE_MS, () => pageState(key), (state) => !!where.calls(state)?.includes(call));
  await command(key, "pause");
  await handled("pause");
  await until(`${where.name}: the song pauses`, SETTLE_MS, () => pageState(key), (state) => where.paused(state) === true);
  await reported(reports, `${where.name}: the muted tab's card reports paused`, isPaused);
  await command(key, "play");
  await handled("play");
  await until(`${where.name}: the song plays again`, SETTLE_MS, () => pageState(key), (state) => where.paused(state) === false);
  await reported(reports, `${where.name}: the muted tab's card reports playing again`, isPlaying);
  await command(key, "seekTo", SEEK_TO);
  await handled(`seekto:${SEEK_TO}`);
  await command(key, "next");
  await handled("nexttrack");
}

const mutedChecks: Check[] = [
  {
    name: "engine now playing: in a muted tab, the card stays and pause, play, seek and next reach the page's own Media Session handlers",
    run: () =>
      withReports("np-muted-main", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await obeysWhileMuted(key, reports, MAIN);
      }),
  },
  {
    name: "engine now playing: in a muted tab, the card stays and pause, play, seek and next reach a cross-site iframe's handlers, and an idle element of the page around it never plays",
    run: () =>
      withReports("np-muted-frame", "npframe?preload", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        await obeysWhileMuted(key, reports, FRAME);
        const main = await pageState(key);
        expectEqual({ paused: main.paused, time: main.time }, { paused: true, time: 0 }, "the page's idle preloaded <audio> never played");
      }),
  },
  {
    name: "engine now playing: a muted preview starting in a muted tab does not take over the card: the song pausing is reported",
    run: () =>
      withReports("np-muted-preview", "nowplaying?preview&long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await mutedAndStillShown(key, reports, MAIN);
        await evaluate(key, 'v.play().then(() => post("result", "true"), () => post("result", "false"));');
        await until("the muted preview video plays", SETTLE_MS, () => playing(key, "v"), (on) => on);
        await pause(MUTE_SETTLES_MS);
        expectEqual((await reports.latest())?.title, SONG.title, "the card still shows the song once the preview plays");
        await pausePage(key);
        await reported(reports, "the song pausing is reported, though the muted preview still plays", isPaused);
        expectTrue(await playing(key, "v"), "the muted preview is still playing");
      }),
  },
  {
    name: "engine now playing: in a muted tab with a muted preview playing, the card's play after its pause resumes the song",
    run: () =>
      withReports("np-muted-resume", "npframe?preview", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        await until("the frame's muted preview video plays too", SETTLE_MS, () => pageState(key), (state) => state.frame?.preview === true);
        await mutedAndStillShown(key, reports, FRAME);
        await command(key, "pause");
        await until("the card's pause pauses the frame's song", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === true);
        await command(key, "play");
        await until("the card's play resumes the frame's song, not the preview", SETTLE_MS, () => pageState(key), (state) => state.frame?.paused === false);
        expectEqual((await pageState(key)).frame?.preview, true, "the muted preview kept playing throughout");
      }),
  },
  {
    name: "engine now playing: in a muted tab, once the song's player is removed, a play at once does nothing and plays no other player the page has",
    run: () =>
      withReports("np-muted-removed", "nowplaying?second&long", TITLE, async (key, reports) => {
        expectEqual(await evaluate(key, 'n.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true), "played", "the other player plays with sound first");
        await startPlaying(key);
        await pause(500);
        await evaluate(key, 'n.pause(); post("result", "true");');
        await mutedAndStillShown(key, reports, MAIN);
        await evaluate(key, 'm.removeAttribute("src"); m.load(); post("result", "true");');
        const answer = await commandReply(key, "play");
        await pause(NOTHING_PLAYS_MS);
        const state = await evaluate(key, 'post("result", JSON.stringify({ song: m.paused, other: n.paused, otherTime: n.currentTime }));');
        expectEqual(state && { song: (state as { song?: unknown }).song, other: (state as { other?: unknown }).other }, { song: true, other: true }, `nothing plays after the play sent once the song's player was removed (mediaCommand answered ${answer}; ${JSON.stringify(state)})`);
        await reported(reports, "the card goes with the song's player", (now) => now === null);
      }),
  },
];

export const checks: Check[] = port ? mutedChecks : [];
