import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port } from "./engineAutoplayKit";
import { evaluate, heard, hide, listed, pause, until } from "./engineSleep";
import { TITLE, activeSessionOf, commandReply, isPlaying, pausePage, reported, startPlaying, withReports, type Reports } from "./engineNowPlayingKit";

const ELEMENT_UNMUTES_AFTER_MS = 2000;
const FOCUS_SETTLES_MS = 1000;
const NOTHING_PLAYS_MS = 1500;
const NOT_DONE = { ok: true, done: false };
const BY_SCRIPT = { ok: true, done: true, byScript: true };
const RECORDED = { ok: true, done: true, recorded: true };
const RESUME_AT = 20;
const EARLIER_SEEK = 5;
const STARTED_FROM_ZERO_BY = 3;
const HELD_RELOAD_MS = 800;
const RELEASE_PAGE = "self-check-np-release";
const REPOST_SETTLES_MS = 1500;
const PLAYED_BEFORE_SECONDS = 0.3;

type Answer = { ok?: boolean; done?: boolean; byScript?: boolean; recorded?: boolean; refused?: string };
type Media = { paused?: boolean; time?: number; played?: number };

const answerOf = async (key: string, action: string, seconds: number | null = null): Promise<Answer> => {
  const reply = await commandReply(key, action, seconds);
  if (reply.startsWith("refused")) return { refused: reply };
  const answer = JSON.parse(reply) as Answer;
  return { ok: answer.ok, done: answer.done, ...(answer.byScript === undefined ? {} : { byScript: answer.byScript }), ...(answer.recorded === undefined ? {} : { recorded: answer.recorded }) };
};
const mediaOf = async (key: string) => ((await evaluate(key, 'post("result", JSON.stringify({ paused: m.paused, time: m.currentTime, played: m.played.length }));')) ?? {}) as Media;
const setMuted = (key: string, muted: boolean) => hostCall("tab.call", { key, method: "setMuted", muted });
const loadedAt = (key: string, marker: string) => until(`the page with ${marker} loads`, LOAD_MS, () => listed(key), (tab) => String(tab?.url).includes(marker) && tab?.title === TITLE && tab.loading === false && tab.discarded !== true);

async function neverPlayed(key: string, what: string) {
  await pause(NOTHING_PLAYS_MS);
  const media = await mediaOf(key);
  expectEqual({ paused: media.paused, played: media.played }, { paused: true, played: 0 }, `${what}: the page's idle player never played (${JSON.stringify(media)})`);
}

async function playedBefore(key: string) {
  await startPlaying(key);
  await until("the page plays before it sleeps, as a tab with a card has", SETTLE_MS, () => mediaOf(key), (media) => media.paused === false && (media.time ?? 0) > PLAYED_BEFORE_SECONDS);
  await pausePage(key);
}

async function discarded(key: string, windowId: string) {
  await playedBefore(key);
  await hide(key, windowId);
  const outcome = (await hostCall<{ outcome?: unknown }>("tab.call", { key, method: "discard" })).outcome;
  expectEqual(outcome, "discarded", "the hidden page is discarded");
}

async function discardedAndReloaded(key: string, windowId: string, method = "reloadToPlay") {
  await discarded(key, windowId);
  await hostCall("tab.call", { key, method });
  await loadedAt(key, "wake");
}

async function releaseHeld(token: string, windowId: string) {
  try {
    await hostCall("tab.create", { key: RELEASE_PAGE, url: `${origin}/a`, profile: "" }, windowId);
    await until("the release page loads", LOAD_MS, () => listed(RELEASE_PAGE), (tab) => tab?.title === "loaded a" && tab.loading === false);
    const freed = await evaluate(RELEASE_PAGE, `fetch("/release?holdonce=${token}", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(Number(t))));`);
    expectEqual(freed, 1, "the page server releases the wake's held request");
  } finally {
    await hostCall("tab.close", { key: RELEASE_PAGE }).catch(() => null);
  }
}

async function dropsItsMedia(key: string, reports: Reports) {
  await evaluate(key, 'm.pause(); m.removeAttribute("src"); m.load(); post("result", "true");');
  await reported(reports, "the session ends once the page drops its media", (now) => now === null);
}

async function onlyNullAfter(reports: Reports, from: number, what: string) {
  await pause(NOTHING_PLAYS_MS);
  const after = reports.reports.slice(from);
  expectEqual(after.filter((state) => state !== null).length, 0, `${what}: nothing of the page navigated away from is reported (${JSON.stringify(after.map((state) => state?.playbackState ?? null))})`);
}

const sessionChecks: Check[] = [
  {
    name: "engine now playing: a muted tab never takes the hardware media keys or the system media controls from a tab that is heard, even when focused, and is eligible again once unmuted",
    run: () =>
      withReports("np-keys-heard", "nowplaying?plain&long", TITLE, (heard, heardReports) =>
        withReports("np-keys-muted", "nowplaying?plain&long", TITLE, async (muted, mutedReports) => {
          await startPlaying(heard);
          await reported(heardReports, "the heard tab reports playing", isPlaying);
          await startPlaying(muted);
          await reported(mutedReports, "the second tab reports playing", isPlaying);
          const bothHeard = { heard: await activeSessionOf(heard), muted: await activeSessionOf(muted) };
          await setMuted(muted, true);
          await until("the heard tab's session is the active one once the other tab is muted", SETTLE_MS, () => activeSessionOf(heard), (state) => state.active === true);
          expectEqual((await activeSessionOf(muted)).active, false, "the muted tab's session is not the active one");
          const mutedCard = await mutedReports.latest();
          expectTrue(isPlaying(mutedCard) && mutedCard?.controllable === true, `the muted tab's card still reports its session, playing and controllable (${JSON.stringify(mutedCard)})`);
          const mayMove = (await hostCall<{ keyboardMayMove?: unknown }>("host.info")).keyboardMayMove === true;
          await hostCall("tab.call", { key: muted, method: "focus", ...(mayMove ? {} : { background: true }) });
          await pause(FOCUS_SETTLES_MS);
          const focused = await hostCall<{ keyboardPage?: unknown }>("host.info");
          expectEqual({ heard: (await activeSessionOf(heard)).active, muted: (await activeSessionOf(muted)).active }, { heard: true, muted: false }, "after the muted tab's page is focused, the heard tab's session is still the active one");
          await setMuted(muted, false);
          await until("the unmuted tab, on top of the focus stack, is the active session again", SETTLE_MS, () => activeSessionOf(muted), (state) => state.active === true);
          console.info(`[ardia windows] self-check note: active session with both heard ${JSON.stringify(bothHeard)}; the focus call ${mayMove ? "could" : "could not"} move the keyboard, keyboard page after it ${JSON.stringify(focused.keyboardPage ?? null)}; once unmuted, the unmuted tab is the active session`);
        }),
      ),
  },
  {
    name: "engine now playing: a page that starts its track muted on the element and unmutes it while playing gets its card",
    run: () =>
      withReports("np-element-muted", "nowplaying?plain&long", TITLE, async (key, reports) => {
        const started = await evaluate(key, 'm.muted = true; m.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
        expectEqual(started, "played", "the page plays its track muted on the element");
        await pause(ELEMENT_UNMUTES_AFTER_MS);
        const whileMuted = reports.reports.filter((state) => state?.controllable === true).length;
        await evaluate(key, 'm.muted = false; post("result", "true");');
        const state = await reported(reports, "the unmuted track is reported playing and controllable", (now) => isPlaying(now) && now?.controllable === true);
        console.info(`[ardia windows] self-check note: ${whileMuted} controllable reports while the element was muted; after unmuting ${JSON.stringify({ playbackState: state?.playbackState, duration: state?.duration })}`);
      }),
  },
  {
    name: "engine now playing: a card play sent right after navigating to a page with an idle player and no session does nothing, no script plays the player, and the page navigated away from is not reported",
    run: () =>
      withReports("np-nav-play", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        const committed = heard("tab", (event) => event.key === key && event.name === "navigation" && String(event.data?.committedUrl).includes("next"), "the next page commits");
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&next` });
        await committed;
        const early = await answerOf(key, "play");
        expectEqual(early, NOT_DONE, "a card play sent as soon as the next page committed, before any session lives there");
        await loadedAt(key, "next");
        const from = reports.reports.length;
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a card play once the next page loaded, with no session there");
        await neverPlayed(key, "after the card's plays");
        await onlyNullAfter(reports, from, "after the next page loaded");
        await hostCall("tab.call", { key, method: "reload" });
        await loadedAt(key, "next");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a card play after an ordinary reload of a tab that was never asleep");
        await neverPlayed(key, "after the reload");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play (reloadToPlay) plays from the start through the wake allowance, and a second play with no session does nothing",
    run: () =>
      withReports("np-wake", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the first play after the wake, with no seek before it");
        const media = await until("the woken page's player plays", SETTLE_MS, () => mediaOf(key), (now) => now.paused === false);
        expectTrue((media.time ?? Infinity) < STARTED_FROM_ZERO_BY, `with no seek recorded the woken player starts at zero (${JSON.stringify(media)})`);
        await reported(reports, "the woken page reports playing", isPlaying);
        await dropsItsMedia(key, reports);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a second play, with no session and the allowance used");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play that then navigates loses the wake allowance",
    run: () =>
      withReports("np-wake-moved", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&moved` });
        await loadedAt(key, "moved");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after the woken page navigated");
        await neverPlayed(key, "after the woken page navigated");
        expectEqual((await reports.latest()) ?? null, null, "no session is reported for the moved page");
      }),
  },
  {
    name: "engine now playing: a sleeping tab woken to play resumes where it was: the seek is only recorded, the latest wins, and the play seeks and plays in one script run",
    run: () =>
      withReports("np-wake-seek", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "seekTo", EARLIER_SEEK), RECORDED, "a seek after the wake, which the host only records");
        expectEqual(await answerOf(key, "seekTo", RESUME_AT), RECORDED, "a later seek, which replaces the recorded one");
        await pause(NOTHING_PLAYS_MS);
        const untouched = await mediaOf(key);
        expectEqual({ paused: untouched.paused, time: untouched.time, played: untouched.played }, { paused: true, time: 0, played: 0 }, "the recorded seeks ran nothing in the page");
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the play, the one script run that seeks and plays");
        const media = await until("the woken page plays from the latest recorded seek", SETTLE_MS, () => mediaOf(key), (now) => now.paused === false && (now.time ?? 0) >= RESUME_AT);
        await reported(reports, "the woken page reports playing", isPlaying);
        await dropsItsMedia(key, reports);
        expectEqual(await answerOf(key, "seekTo", 1), NOT_DONE, "a seek after the play, with the allowance used and no session");
        console.info(`[ardia windows] self-check note: a woken tab resumed at ${media.time} s after recorded seeks to ${EARLIER_SEEK} s and ${RESUME_AT} s`);
      }),
  },
  {
    name: "engine now playing: a toggle after a wake uses the allowance up, so a later play with no session does nothing",
    run: () =>
      withReports("np-wake-toggle", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        expectEqual(await answerOf(key, "toggle"), BY_SCRIPT, "a toggle after the wake plays through the allowance");
        await until("the woken page's player plays", SETTLE_MS, () => mediaOf(key), (now) => now.paused === false);
        await reported(reports, "the woken page reports playing", isPlaying);
        await dropsItsMedia(key, reports);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after the toggle, with the allowance used and no session");
      }),
  },
  {
    name: "engine now playing: a sleeping tab reloaded by the user (a plain reload) gets no wake allowance",
    run: () =>
      withReports("np-wake-plain", "nowplaying?plain&long&wake", TITLE, async (key, _reports, windowId) => {
        await discardedAndReloaded(key, windowId, "reload");
        expectEqual(await answerOf(key, "seekTo", RESUME_AT), NOT_DONE, "a seek after the user's own reload");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after the user's own reload");
        await neverPlayed(key, "after the user's own reload");
      }),
  },
  {
    name: "engine now playing: a wake whose reload the host's own navigation replaces before it commits leaves no allowance for the page that loads instead",
    run: () =>
      withReports("np-wake-replaced", "nowplaying?plain&long&wake", TITLE, async (key, _reports, windowId) => {
        await discarded(key, windowId);
        await hostCall("tab.call", { key, method: "reloadToPlay" });
        await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/nowplaying?plain&long&replaced` });
        await loadedAt(key, "replaced");
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play on the page that replaced the wake's reload");
        await neverPlayed(key, "on the page that replaced the wake's reload");
      }),
  },
  {
    name: "engine now playing: a second reloadToPlay while the first wake's reload is pending keeps that wake: the page loads when its request is released and uses the one allowance once",
    run: () => {
      const token = `w${Date.now()}`;
      return withReports("np-wake-twice", `nowplaying?plain&long&wake&holdonce=${token}`, TITLE, async (key, reports, windowId) => {
        await discarded(key, windowId);
        await hostCall("tab.call", { key, method: "reloadToPlay" });
        await pause(HELD_RELOAD_MS);
        const second = await hostCall<{ ok?: unknown }>("tab.call", { key, method: "reloadToPlay" });
        expectEqual(second?.ok, true, "the engine answers the second reloadToPlay");
        const waiting = await listed(key);
        console.info(`[ardia windows] self-check note: while the first wake's reload waited for its held page the tab was ${JSON.stringify({ loading: waiting?.loading, discarded: waiting?.discarded })}`);
        expectEqual({ listed: waiting?.key, loading: waiting?.loading }, { listed: key, loading: true }, "the tab is still listed and still loading its held page");
        await releaseHeld(token, windowId);
        await loadedAt(key, "wake");
        expectEqual(await answerOf(key, "play"), BY_SCRIPT, "the play on the page the kept wake loaded");
        await until("the woken page's player plays", SETTLE_MS, () => mediaOf(key), (now) => now.paused === false);
        await reported(reports, "the woken page reports playing", isPlaying);
        await dropsItsMedia(key, reports);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a second play, with no session and the one allowance used");
      });
    },
  },
  {
    name: "engine now playing: a wake whose reload Chromium holds back behind its form resubmission warning arms nothing",
    run: () =>
      withReports("np-wake-repost", "nowplaying?plain&long&wake&repost", TITLE, async (key, _reports, windowId) => {
        await loadedAt(key, "posted");
        await discarded(key, windowId);
        await hostCall("tab.call", { key, method: "reloadToPlay" });
        await pause(REPOST_SETTLES_MS);
        const held = await listed(key);
        console.info(`[ardia windows] self-check note: after reloadToPlay of a discarded page that came from a form post, the tab is ${JSON.stringify({ loading: held?.loading, discarded: held?.discarded, url: held?.url })}`);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a play after a reload that started no navigation");
      }),
  },
  {
    name: "engine now playing: after a wake, a play the page's live session takes uses the allowance up, so a later play with no session does nothing",
    run: () =>
      withReports("np-wake-session", "nowplaying?plain&long&wake", TITLE, async (key, reports, windowId) => {
        await discardedAndReloaded(key, windowId);
        await startPlaying(key);
        await reported(reports, "the woken page plays by itself and reports it", isPlaying);
        await pausePage(key);
        expectEqual(await answerOf(key, "play"), { ok: true, done: true }, "a card play the live session takes, not the script");
        await until("the session's play plays the page", SETTLE_MS, () => mediaOf(key), (media) => media.paused === false);
        await dropsItsMedia(key, reports);
        expectEqual(await answerOf(key, "play"), NOT_DONE, "a later play with no session, the allowance already used by the session's play");
      }),
  },
];

export const checks: Check[] = port ? sessionChecks : [];
