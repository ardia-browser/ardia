import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const media = await import("./media.ts");
const { cardTargetNow } = await import("../sidebar/cardTarget.ts");

const S = () => useBrowser.getState();

function pinnedPlayer() {
  S().hydrate({});
  S().updateSettings({ showTabHoverMenu: false, sidebarMediaControls: true });
  const w = S().createWindow({ url: "a.com" });
  const tab = S().newTab(w, { url: "music.com", background: true });
  S().pinTabs([tab], true);
  media.useMedia.setState((m) => ({ sessions: { ...m.sessions, [tab]: { controllable: true, playbackState: "playing", title: "Song", artwork: null } } }));
  return tab;
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
