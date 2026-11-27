import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const media = await import("./media.ts");
const { cardTargetNow } = await import("../sidebar/cardTarget.ts");
const { useCardTarget, useRowHoverCell } = await import("../../components/sidebar/hoverController.ts");
const { forgetRowsScrolled, noteRowsScrolled } = await import("../sidebar/hover.ts");
const { takeHoverCardCounts } = await import("../telemetry/hoverCardCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();

function pinnedPlayer(playbackState = "playing") {
  S().hydrate({});
  S().updateSettings({ showTabHoverMenu: false, sidebarMediaControls: true });
  const w = S().createWindow({ url: "a.com" });
  const tab = S().newTab(w, { url: "music.com", background: true });
  S().pinTabs([tab], true);
  reportMedia(tab, playbackState);
  return tab;
}

function reportMedia(tab, playbackState, over = {}) {
  media.setNowPlaying(tab, {
    controllable: true,
    playbackState,
    title: "Preloaded clip",
    artwork: null,
    artist: "",
    album: "",
    duration: 138,
    position: 0,
    playbackRate: 1,
    timestamp: Date.now(),
    hasVideo: false,
    actions: ["play", "pause"],
    ...over,
  });
}

test("turning sidebar media controls off restyles a pinned player with no change to its tab", () => {
  const tab = pinnedPlayer();
  const hook = mount(() => media.usePinnedWithMediaControls(tab));
  assert.equal(hook.value, true);
  const tabs = S().tabs;
  S().updateSettings({ sidebarMediaControls: false });
  assert.equal(S().tabs, tabs, "the tab record didn't change");
  assert.equal(hook.value, false);
  S().updateSettings({ sidebarMediaControls: true });
  assert.equal(hook.value, true);
  hook.unmount();
});

test("with sidebar media controls off, the pointer doesn't treat a pinned player as a media card", () => {
  const tab = pinnedPlayer();
  const target = { kind: "tab", id: tab };
  assert.equal(cardTargetNow(target), target);
  S().updateSettings({ sidebarMediaControls: false });
  assert.equal(cardTargetNow(target), null);
});

test("paused metadata without playback keeps the normal hover card or no card", (t) => {
  const tab = pinnedPlayer("paused");
  const target = { kind: "tab", id: tab };
  const player = mount(() => media.useShowsMiniPlayer(tab));
  const card = mount(() => useCardTarget(target));
  t.after(() => {
    card.unmount();
    player.unmount();
    media.setNowPlaying(tab, null);
  });

  S().updateSettings({ showTabHoverMenu: true });
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [false, target, target]);

  S().updateSettings({ showTabHoverMenu: false });
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [false, null, null]);
});

test("the media-only hover card follows playback and closes when controls or the session go away", (t) => {
  const tab = pinnedPlayer("paused");
  const target = { kind: "tab", id: tab };
  const player = mount(() => media.useShowsMiniPlayer(tab));
  const card = mount(() => useCardTarget(target));
  t.after(() => {
    card.unmount();
    player.unmount();
    media.setNowPlaying(tab, null);
  });

  reportMedia(tab, "playing");
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [true, target, target]);
  reportMedia(tab, "paused");
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [true, target, target]);

  S().updateSettings({ sidebarMediaControls: false });
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [false, null, null]);
  S().updateSettings({ sidebarMediaControls: true });
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [true, target, target]);

  media.setNowPlaying(tab, null);
  assert.deepEqual([player.value, card.value, cardTargetNow(target)], [false, null, null]);
});

test("a blocked hover player is counted only while sharing diagnostics", (t) => {
  const tab = pinnedPlayer("paused");
  const row = mount(() => useRowHoverCell(S().tabs[tab].windowId, { kind: "tab", id: tab }));
  t.after(() => {
    setConsentPeriod(false, null);
    takeHoverCardCounts();
    row.unmount();
    media.setNowPlaying(tab, null);
  });

  const hover = () => {
    row.value.hoverProps.onMouseEnter();
    row.value.hoverProps.onMouseLeave();
    return takeHoverCardCounts().tab_hover_players_skipped_before_playback;
  };

  assert.equal(hover(), 0);
  setConsentPeriod(true, "hover-test");
  assert.equal(hover(), 1);
  reportMedia(tab, "playing");
  assert.equal(hover(), 0);
});

test("a short sound that was never controllable doesn't count as playback, with or without a title", (t) => {
  const tab = pinnedPlayer("paused");
  const player = mount(() => media.useShowsMiniPlayer(tab));
  t.after(() => {
    player.unmount();
    media.setNowPlaying(tab, null);
  });
  const artworkOnly = { title: "", artwork: "https://music.com/cover.png" };

  for (const over of [{}, artworkOnly]) {
    media.setNowPlaying(tab, null);
    reportMedia(tab, "playing", { ...over, controllable: false });
    reportMedia(tab, "paused", over);
    assert.equal(player.value, false);
  }
  reportMedia(tab, "playing", artworkOnly);
  reportMedia(tab, "paused", artworkOnly);
  assert.equal(player.value, true);
});

test("only a pinned tab with media controls and ready media counts a blocked hover player", (t) => {
  const tab = pinnedPlayer("paused");
  const row = mount(() => useRowHoverCell(S().tabs[tab].windowId, { kind: "tab", id: tab }));
  setConsentPeriod(true, "hover-test");
  t.after(() => {
    setConsentPeriod(false, null);
    takeHoverCardCounts();
    row.unmount();
    media.setNowPlaying(tab, null);
  });
  const hover = () => {
    row.value.hoverProps.onMouseEnter();
    row.value.hoverProps.onMouseLeave();
    return takeHoverCardCounts().tab_hover_players_skipped_before_playback;
  };

  for (const over of [{ controllable: false }, { playbackState: "none" }, { title: "", artwork: null }]) {
    reportMedia(tab, "paused", over);
    assert.equal(hover(), 0, JSON.stringify(over));
  }
  reportMedia(tab, "paused", { title: "", artwork: "https://music.com/cover.png" });
  assert.equal(hover(), 1);
  S().updateSettings({ sidebarMediaControls: false });
  assert.equal(hover(), 0);
  S().updateSettings({ sidebarMediaControls: true });
  S().pinTabs([tab], false);
  assert.equal(hover(), 0);
});

test("a blocked hover player under a scrolling sidebar counts once it settles, and not if the pointer left", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const tab = pinnedPlayer("paused");
  const windowId = S().tabs[tab].windowId;
  const row = mount(() => useRowHoverCell(windowId, { kind: "tab", id: tab }));
  setConsentPeriod(true, "hover-test");
  t.after(() => {
    setConsentPeriod(false, null);
    takeHoverCardCounts();
    forgetRowsScrolled(windowId);
    row.unmount();
    media.setNowPlaying(tab, null);
  });
  const taken = () => takeHoverCardCounts().tab_hover_players_skipped_before_playback;

  noteRowsScrolled(windowId);
  row.value.hoverProps.onMouseEnter();
  assert.equal(taken(), 0);
  t.mock.timers.tick(2000);
  assert.equal(taken(), 1);
  row.value.hoverProps.onMouseLeave();

  noteRowsScrolled(windowId);
  row.value.hoverProps.onMouseEnter();
  row.value.hoverProps.onMouseLeave();
  t.mock.timers.tick(2000);
  assert.equal(taken(), 0);
});
