import assert from "node:assert/strict";
import { after, test } from "node:test";

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = realSetTimeout(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const loading = await import("./profileLoading.ts");
const { checkIdleProfiles, profileUnloadingForTests, startProfileUnloading } = await import("./profileUnloading.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("an unloaded profile reopened with sharing off doesn't count its reload time when the engine reports it loaded after sharing turns on", async () => {
  sharing(true);
  const clock = 0;
  profileUnloadingForTests(() => clock);
  startProfileUnloading();
  stub.loadedEngineProfiles.clear();
  for (const engine of ["", "work", "play"]) stub.loadedEngineProfiles.add(engine);
  stub.profilesLoadedCall.known = true;
  stub.idleProfileUnloads.clear();
  const tab = (id, profileId, url) => ({ id, windowId: "w1", profileId, url, title: id, favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "loaded", nav: { url, seq: 1 } }, openerId: null, createdAt: 0, lastActiveAt: 0 });
  const tabs = [tab("t-work", "work", "https://work.example/"), tab("t-play", "play", "https://play.example/")];
  S().hydrate({
    profiles: { default: PERSONAL, work: { ...PERSONAL, id: "work", name: "Work", createdAt: 1 }, play: { ...PERSONAL, id: "play", name: "Play", createdAt: 2 } },
    profileOrder: ["default", "work", "play"], settings: { unloadProfilesAfter: "5m", memorySaver: true },
    windows: { w1: { id: "w1", profileId: "work", kind: "main", tabIds: tabs.map((t) => t.id), activeTabIds: { work: "t-work", play: "t-play" }, sidebarOpen: true, frame: null, createdAt: 0 } },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])), focusedWindowId: "w1",
  });
  const stop = loading.startProfileLoading();
  await until(() => loading.profileOpened("play"), "the engine's loaded profiles");
  stub.idleProfileUnloads.set("play", { status: "pending", tabs: ["t-play"] });
  await checkIdleProfiles(clock);
  await checkIdleProfiles(clock + 5 * 60_000);
  assert.equal(loading.profileOpened("play"), false, "the profile unloads");
  sharing(false);
  loading.openProfile("play");
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  sharing(true);
  takeTabSleepCounts();
  stub.emitEvent("profiles.loaded", { profile: "play" });
  const counts = takeTabSleepCounts();
  assert.deepEqual([counts.unloaded_profiles_reopened, counts.unloaded_profile_reload_ms], [0, 0]);
  stop();
});
