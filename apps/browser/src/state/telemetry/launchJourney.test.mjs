import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const { NativeModules } = await import("react-native");
const processStart = Date.now() - 1500;
Object.assign(stub.appInfo, {
  appVersion: "0.3.0",
  osVersion: "27.0.1",
  arch: "arm64",
  isolatedInstance: false,
  processStart,
  launchMarks: {
    mainStarted: processStart + 40,
    startupPrepared: processStart + 700,
    chromiumEntered: processStart + 720,
    appKitWillFinish: processStart + 5200,
    appKitDidFinish: processStart + 6100,
    engineStarted: processStart + 6400,
    earlyWindowShown: processStart + 6600,
    reactNativeStarted: processStart + 6900,
  },
  launchedHidden: true,
  launchSource: "login_item",
  loadAverage1m: 7.126,
});
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
NativeModules.ACFieldTiming.drain = () => [["launch", "content", Date.now()]];
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const journeys = await import("./journeys.ts");
const track = await import("./track.ts");
const { useBrowser } = await import("../browser/store.ts");
const DAY = 86_400_000;
const page = (url, daysAgo) => ({ url, title: url, favicon: null, visits: 1, lastVisit: Date.now() - daysAgo * DAY });
useBrowser.setState({ history: { "": { list: [page("https://a.com/", 1), page("https://b.com/", 200), page("https://arc-import.com/", 2 * 365)], floor: -Infinity, ready: true } } });
after(() => client.setSharing(false, "settings"));

test("a launch with sharing on at start sends one perf_launch with launch_ms, however many windows open", async () => {
  client.loadChoice();
  assert.equal(client.isSharing(), true);
  journeys.startJourneys(null);

  journeys.launchCommitted(client.consentNow(), Date.now() - 20);
  journeys.launchCommitted(client.consentNow(), Date.now() - 5000);
  assert.equal(journeys.devJourneys().pending.length, 1);
  const deadline = Date.now() + 10_000;
  while (journeys.devJourneys().pending[0]?.usable === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(journeys.devJourneys().pending[0]?.usable, undefined);
  track.markFirstWindow();
  journeys.launchCommitted(client.consentNow());
  journeys.emitJourneys();
  journeys.journeysEnding();

  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json"));
  const launches = saved.events.filter((e) => e.event === "perf_launch");
  assert.equal(launches.length, 1);
  const { launch_ms, commit_ms, first_commit_ms, usable_ms } = launches[0].properties;
  assert.ok(launch_ms >= 1500 && launch_ms < 60_000, `launch_ms ${launch_ms}`);
  assert.ok(commit_ms >= 1500 && commit_ms <= launch_ms, `commit_ms ${commit_ms}`);
  assert.ok(usable_ms >= 1500 && usable_ms < 60_000, `usable_ms ${usable_ms}`);
  assert.ok(first_commit_ms >= 20 && first_commit_ms < 1000, `first_commit_ms ${first_commit_ms}: the first root to commit, from its own render, not a later root's`);
});

test("perf_launch carries the early launch marks in order from process start, the load average and whether the launch was hidden", () => {
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json"));
  const { main_ms, startup_ms, chromium_ms, engine_ms, early_window_ms, rn_ms, load_1m, launched_hidden } = saved.events.find((e) => e.event === "perf_launch").properties;
  assert.deepEqual([main_ms, startup_ms, chromium_ms, engine_ms, early_window_ms, rn_ms], [40, 700, 720, 6400, 6600, 6900]);
  assert.equal(load_1m, 7.13);
  assert.equal(launched_hidden, true);
});

test("perf_launch says in ranges how much history there is and how old its oldest page is, so imported history past 90 days shows", () => {
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json"));
  const { history, history_oldest } = saved.events.find((e) => e.event === "perf_launch").properties;
  assert.equal(history, "<100");
  assert.equal(history_oldest, "<3y");
});

test("perf_launch says whether a login item, another app's link or file, or the user started the launch, and when AppKit finished launching", () => {
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json"));
  const { launch_source, appkit_will_finish_ms, appkit_did_finish_ms } = saved.events.find((e) => e.event === "perf_launch").properties;
  assert.equal(launch_source, "login_item");
  assert.deepEqual([appkit_will_finish_ms, appkit_did_finish_ms], [5200, 6100]);
});
