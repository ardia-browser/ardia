import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const media = await import("./media.ts");

const S = () => useBrowser.getState();
const M = () => media.useMedia.getState();
const report = (overrides = {}) => ({
  title: "Song", artist: "Band", album: "", artwork: null, playbackState: "playing", position: 10, duration: 200,
  playbackRate: 1, timestamp: Date.now(), hasVideo: false, actions: ["play", "pause"], controllable: true, ...overrides,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function twoPlaying() {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com", background: true });
  const c = S().newTab(w, { url: "c.com", background: true });
  const sent = [];
  for (const id of [b, c]) webviews.set(id, { mediaCommand: async (action) => void sent.push([id, action]) });
  media.setNowPlaying(b, report());
  await tick();
  media.setNowPlaying(c, report());
  let shown = media.playerTabFor(M(), [b, c]);
  const player = () => (shown = media.playerTabFor(M(), [b, c], shown));
  return { b, c, sent, player };
}

test("pausing the tab the sidebar player shows keeps the player on it", async () => {
  const { b, c, sent, player } = await twoPlaying();
  assert.equal(player(), c);

  media.mediaCommand(c, "toggle");
  assert.deepEqual(sent, [[c, "toggle"]]);
  assert.equal(M().sessions[c].playbackState, "playing", "nothing changes until the page reports it");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(player(), c, "paused, while the other tab still plays");

  media.setNowPlaying(c, null);
  assert.equal(player(), b, "its session ended: the next one");
  for (const id of [b, c]) webviews.delete(id);
});

test("a late playing report doesn't move the sidebar player", async () => {
  const { b, c, player } = await twoPlaying();
  assert.equal(player(), c);
  media.mediaCommand(c, "pause");
  const playedAt = M().sessions[c].playedAt;
  media.setNowPlaying(c, report({ position: 11 }));
  assert.equal(player(), c);
  assert.equal(M().sessions[c].playedAt, playedAt, "still the same play, not a new one");
  media.setNowPlaying(c, report({ playbackState: "paused", position: 11 }));
  assert.equal(player(), c);
  media.setNowPlaying(c, report({ position: 11 }));
  assert.equal(player(), c);
  assert.equal(M().sessions[b].playbackState, "playing");
  for (const id of [b, c]) webviews.delete(id);
});

test("closing the sidebar player hands it to the next tab", async () => {
  const { b, c, player } = await twoPlaying();
  assert.equal(player(), c);
  media.useMedia.setState({ dismissed: { [c]: true } });
  assert.equal(player(), b);
  for (const id of [b, c]) webviews.delete(id);
});

test("media that never played with sound gets no sidebar player until it does", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const feed = S().newTab(w, { url: "x.com", background: true });
  const pick = () => media.playerTabFor(M(), [feed]);
  media.setNowPlaying(feed, report({ title: "Home / X", controllable: false }));
  assert.equal(pick(), undefined, "muted autoplay");
  media.setNowPlaying(feed, report({ title: "Home / X", playbackState: "paused", controllable: false }));
  assert.equal(pick(), undefined, "paused muted autoplay");
  media.setNowPlaying(feed, report({ title: "Home / X", controllable: true }));
  assert.equal(pick(), feed, "unmuted while playing");
  assert.ok(M().sessions[feed].playedAt > 0);
  media.setNowPlaying(feed, report({ title: "Home / X", controllable: false }));
  assert.equal(pick(), undefined, "another muted video took over the page");
});

test("play on a sleeping tab reloads it and resumes where it paused", async () => {
  const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com", background: true });
  const sent = [];
  let reloads = 0;
  webviews.set(b, { reload: async () => void reloads++, mediaCommand: async (action, seconds) => void sent.push([action, seconds]) });
  media.setNowPlaying(b, report());
  media.setNowPlaying(b, report({ playbackState: "paused", position: 95 }));
  useLifecycle.setState({ discarded: { [b]: true } });

  media.mediaCommand(b, "toggle");
  media.mediaCommand(b, "play");
  media.mediaCommand(b, "next");
  assert.equal(reloads, 1, "one reload however often it's pressed");
  assert.deepEqual(sent, [], "nothing goes to a page that isn't there");

  useLifecycle.setState({ discarded: {} });
  media.setNowPlaying(b, null);
  media.setNowPlaying(b, report({ playbackState: "paused", position: 0, controllable: false }));
  assert.deepEqual(sent, [["seekTo", 95], ["play", undefined]]);
  media.setNowPlaying(b, report({ playbackState: "paused", position: 95 }));
  assert.equal(sent.length, 2, "it resumes once");
  media.setNowPlaying(b, null);
  webviews.delete(b);
});

test("a woken page that plays on its own, or plays something else, isn't sought", () => {
  const before = { ...report({ playbackState: "paused", position: 95 }), playedAt: 1 };
  assert.deepEqual(media.resumeCommands(before, report({ playbackState: "playing", position: 0 })), []);
  assert.deepEqual(media.resumeCommands(before, report({ title: "Other", playbackState: "paused", position: 0 })), [["play"]]);
  assert.deepEqual(media.resumeCommands(before, report({ playbackState: "paused", position: 93 })), [["play"]]);
  assert.deepEqual(media.resumeCommands(undefined, report({ playbackState: "paused", position: 0 })), [["play"]]);
});

test("play on a sleeping tab whose page reports no media session still resumes once the page has loaded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com", background: true });
  const sent = [];
  webviews.set(b, { reload: async () => {}, mediaCommand: async (action, seconds) => void sent.push([action, seconds]) });
  media.setNowPlaying(b, report());
  media.setNowPlaying(b, report({ playbackState: "paused", position: 95 }));
  useLifecycle.setState({ discarded: { [b]: true } });

  media.mediaCommand(b, "toggle");
  useLifecycle.setState({ discarded: {} });
  media.setNowPlaying(b, null);
  S().updateLive(b, { isLoading: true });
  t.mock.timers.tick(5000);
  assert.deepEqual(sent, [], "nothing while the page loads");
  S().updateLive(b, { isLoading: false });
  t.mock.timers.tick(5000);
  assert.deepEqual(sent, [["seekTo", 95], ["play", undefined]], "a plain <video> with no MediaSession reports nothing until it plays");
  webviews.delete(b);
});

async function playingIn(url) {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url });
  media.setNowPlaying(b, report());
  return { w, a, b };
}

test("a tab paused before you leave it gets no sidebar player, one you leave playing keeps it after a pause", async () => {
  const left = await playingIn("b.com");
  media.setNowPlaying(left.b, report({ playbackState: "paused" }));
  S().activate(left.a);
  assert.equal(M().leftPaused[left.b], true, "paused, then left");

  const kept = await playingIn("c.com");
  S().activate(kept.a);
  assert.equal(M().leftPaused[kept.b], undefined, "left playing");
  media.setNowPlaying(kept.b, report({ playbackState: "paused" }));
  assert.equal(M().leftPaused[kept.b], undefined, "paused after it was left: its player stays");
});

test("a left-paused tab gets its player back when it plays again or when you go back to it", async () => {
  const { a, b } = await playingIn("b.com");
  media.setNowPlaying(b, report({ playbackState: "paused" }));
  S().activate(a);
  assert.equal(M().leftPaused[b], true);
  media.setNowPlaying(b, report());
  assert.equal(M().leftPaused[b], undefined, "played in the background");

  media.setNowPlaying(b, report({ playbackState: "paused" }));
  S().activate(b);
  media.setNowPlaying(b, report({ playbackState: "paused", position: 12 }));
  S().activate(a);
  assert.equal(M().leftPaused[b], true, "left paused again");
  S().activate(b);
  assert.equal(M().leftPaused[b], undefined, "shown again");
});

function sidebarPlayer(windowId) {
  let shown;
  return () => {
    const hidden = media.hiddenPlayerTabs(S(), windowId, S().windows[windowId].profileId, Object.keys(M().sessions));
    return (shown = media.playerTabFor(M(), media.sidebarPlayerCandidates(M(), hidden), shown));
  };
}

async function pausedInTheBackground() {
  const { w, a, b } = await playingIn("b.com");
  S().activate(a);
  const c = S().newTab(w, { url: "c.com", background: true });
  const player = sidebarPlayer(w);
  assert.equal(player(), b, "left playing");
  media.setNowPlaying(b, report({ playbackState: "paused" }));
  assert.equal(player(), b, "paused after it was left: its player stays so it can be resumed");
  await tick();
  return { w, a, b, c, player };
}

test("a tab paused in the background gives the sidebar player to a tab that starts playing in the background", async () => {
  const { b, c, player } = await pausedInTheBackground();
  media.setNowPlaying(c, report());
  assert.equal(player(), c, "the newly playing tab");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(player(), c, "paused in turn: it keeps the player");
  assert.equal(M().leftPaused[b], true);
});

test("a tab paused in the background loses the sidebar player to a tab that starts playing on screen, and doesn't get it back when that tab pauses", async () => {
  const { a, b, c, player } = await pausedInTheBackground();
  S().activate(c);
  media.setNowPlaying(c, report());
  assert.equal(player(), undefined, "the playing tab is on screen and the paused one is stale");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(player(), undefined, "nothing playing now: the stale card stays gone");
  media.setNowPlaying(c, null);
  assert.equal(player(), undefined, "its session ended");
  media.setNowPlaying(b, report());
  assert.equal(player(), b, "playing again in the background");
  S().activate(a);
  assert.equal(player(), b);
});

test("a play that started earlier doesn't take the sidebar player from a tab paused later", async () => {
  const { b, c, player } = await pausedInTheBackground();
  media.setNowPlaying(c, report());
  assert.equal(player(), c);
  media.setNowPlaying(b, report());
  assert.equal(player(), c, "b plays again, but c started first");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(player(), c, "paused in the background while b plays: c keeps the player");
  media.setNowPlaying(b, report({ playbackState: "paused" }));
  assert.equal(player(), c);
});

test("a play in another window or profile doesn't take the sidebar player", async () => {
  const { w, b, player } = await pausedInTheBackground();
  const otherWindow = S().createWindow({ url: "z.com" });
  const z = S().newTab(otherWindow, { url: "z2.com", background: true });
  media.setNowPlaying(z, report());
  assert.equal(M().leftPaused[b], undefined, "another window");
  assert.equal(player(), b);

  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const y = S().newTab(w, { url: "y.com" });
  media.setNowPlaying(y, report());
  assert.equal(M().leftPaused[b], undefined, "another profile");
});

test("a session that ends while its tab is in the background stops being left paused", async () => {
  const { a, b } = await playingIn("b.com");
  media.setNowPlaying(b, report({ playbackState: "paused" }));
  S().activate(a);
  media.setNowPlaying(b, null);
  assert.equal(M().leftPaused[b], undefined);
});

test("a looping clip's position wraps past its end instead of stopping there", () => {
  const at = 1_000_000;
  const looping = report({ position: 11, duration: 12, timestamp: at, loop: true });
  assert.equal(media.positionOf(looping, at + 3000), 2);
  assert.equal(media.positionOf({ ...looping, loop: false }, at + 3000), 12);
  assert.equal(media.positionOf({ ...looping, playbackState: "paused" }, at + 3000), 11);
});

test("a looping clip's report from its start counts as a restart, a report moving on does not", () => {
  const at = 1_000_000;
  const before = report({ position: 0, duration: 12, timestamp: at, loop: true });
  assert.equal(media.isLoopRestart(before, report({ position: 0.1, duration: 12, timestamp: at + 12_000, loop: true })), true);
  assert.equal(media.isLoopRestart(before, report({ position: 5, duration: 12, timestamp: at + 5_000, loop: true })), false);
  assert.equal(media.isLoopRestart(before, report({ position: 0.1, duration: 12, timestamp: at + 12_000 })), false);
  assert.equal(media.isLoopRestart({ ...before, playbackState: "paused" }, report({ position: 0.1, duration: 12, timestamp: at + 12_000, loop: true })), false);
});

test("a page's report moving back is counted, a loop's restart and the card's own seek are not", async () => {
  const { takeMediaCardCounts } = await import("../telemetry/mediaCardCounts.ts");
  const positions = () => {
    const { now_playing_loop_restarts, media_position_rewinds, media_reports_past_end } = takeMediaCardCounts();
    return { now_playing_loop_restarts, media_position_rewinds, media_reports_past_end };
  };
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com", background: true });
  takeMediaCardCounts();
  media.setNowPlaying(b, report({ position: 1, duration: 12, timestamp: 0 }));
  media.setNowPlaying(b, report({ position: 0.4, duration: 12, timestamp: 11_500 }));
  media.setNowPlaying(b, report({ position: 0.2, duration: 12, timestamp: 30_000 }));
  assert.deepEqual(positions(), { now_playing_loop_restarts: 0, media_position_rewinds: 2, media_reports_past_end: 1 }, "the second report came after the countdown ran out");

  media.setNowPlaying(b, report({ position: 10, duration: 12, timestamp: 40_000, loop: true }));
  media.setNowPlaying(b, report({ position: 0.1, duration: 12, timestamp: 45_000, loop: true }));
  assert.deepEqual(positions(), { now_playing_loop_restarts: 1, media_position_rewinds: 0, media_reports_past_end: 0 }, "a loop wraps instead of running out");

  media.seekTo(b, M().sessions[b], 0);
  assert.deepEqual(positions(), { now_playing_loop_restarts: 0, media_position_rewinds: 0, media_reports_past_end: 0 }, "the card's own seek isn't a page report");
});

async function playingInAnotherProfile(across) {
  S().hydrate({});
  S().updateSettings({ playingNowAcrossProfiles: across });
  const w = S().createWindow({ url: "a.com" });
  const home = S().windows[w].profileId;
  const music = S().newTab(w, { url: "music.com" });
  media.setNowPlaying(music, report());
  S().newTab(w, { url: "home.com" });
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  S().newTab(w, { url: "y.com" });
  await tick();
  const playerIn = (profileId) => media.playerTabFor(M(), media.sidebarPlayerCandidates(M(), media.hiddenPlayerTabs(S(), w, profileId, Object.keys(M().sessions))));
  return { w, home, work, music, playerIn };
}

test("off, the Playing now card stays in the profile whose tab plays", async () => {
  const { home, work, music, playerIn } = await playingInAnotherProfile(false);
  assert.equal(playerIn(home), music, "its own profile's page");
  assert.equal(playerIn(work), undefined, "the profile you switched to");
});

test("across profiles, a tab left playing in another profile shows its card in every profile of the window", async () => {
  const { w, home, work, music, playerIn } = await playingInAnotherProfile(true);
  assert.equal(playerIn(work), music, "the profile you switched to");
  assert.equal(playerIn(home), music, "the profile you swipe back through");
  S().switchProfile(w, home);
  assert.equal(playerIn(home), music, "back in its profile, another tab on screen");
  S().activate(music);
  assert.equal(playerIn(home), undefined, "back on screen");
});

test("across profiles, every profile's page shows the same card, even ones that picked different cards before", async () => {
  S().hydrate({});
  S().updateSettings({ playingNowAcrossProfiles: false });
  const w = S().createWindow({ url: "a.com" });
  const home = S().windows[w].profileId;
  const music = S().newTab(w, { url: "music.com" });
  media.setNowPlaying(music, report());
  S().newTab(w, { url: "home.com" });
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const video = S().newTab(w, { url: "video.com" });
  await tick();
  media.setNowPlaying(video, report());
  S().newTab(w, { url: "work.com" });
  const page = (profileId) => {
    let own;
    return () => (own = media.sidebarPlayerTabFor(M(), media.sidebarPlayerCandidates(M(), media.hiddenPlayerTabs(S(), w, profileId, Object.keys(M().sessions))), w, own, S().settings.playingNowAcrossProfiles));
  };
  const homePage = page(home);
  const workPage = page(work);
  assert.equal(homePage(), music, "off: each profile's own");
  assert.equal(workPage(), video, "off: each profile's own");
  S().updateSettings({ playingNowAcrossProfiles: true });
  assert.equal(homePage(), video, "the newest play");
  assert.equal(workPage(), video, "the same card");
  media.setNowPlaying(video, report({ playbackState: "paused" }));
  assert.equal(homePage(), workPage(), "still the same card after a pause");

  media.setNowPlaying(music, report({ playbackState: "paused" }));
  S().updateSettings({ playingNowAcrossProfiles: false });
  homePage();
  workPage();
  media.setNowPlaying(music, report());
  S().updateSettings({ playingNowAcrossProfiles: true });
  assert.equal(homePage(), music, "turned on again: the tab that played meanwhile, not the old paused pick");
  assert.equal(workPage(), music);
});

test("across profiles, a tab paused before you switch profiles gets no card, and a play in another profile takes the paused card", async () => {
  S().hydrate({});
  S().updateSettings({ playingNowAcrossProfiles: true });
  const w = S().createWindow({ url: "a.com" });
  const home = S().windows[w].profileId;
  const music = S().newTab(w, { url: "music.com" });
  media.setNowPlaying(music, report({ playbackState: "paused" }));
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  assert.equal(M().leftPaused[music], true, "paused, then left for another profile");

  S().switchProfile(w, home);
  media.setNowPlaying(music, report());
  S().switchProfile(w, work);
  assert.equal(M().leftPaused[music], undefined, "left playing");
  media.setNowPlaying(music, report({ playbackState: "paused" }));
  const video = S().newTab(w, { url: "video.com", background: true });
  media.setNowPlaying(video, report());
  assert.equal(M().leftPaused[music], true, "another profile's play takes over the paused card");
});
