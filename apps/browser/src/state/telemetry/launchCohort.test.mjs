import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const { NativeModules } = await import("react-native");
const DAY = 86_400_000;
const processStart = Date.now() - 1500;
const bootTime = processStart - 60_000;
const versionSince = processStart - 3 * DAY;
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "30", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart, bootTime, launchMarks: {} });
stub.docs.set(
  "telemetry.json",
  JSON.stringify({ version: 2, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", lastBuild: "30", sessionOpen: false, lastLaunchAt: bootTime - DAY, versionSince, versionColdLaunches: 1 }),
);
NativeModules.ACFieldTiming.drain = () => [["launch", "content", Date.now()]];
globalThis.fetch = async () => ({ status: 200 });

const { nextLaunchCohort, coldNthBucket, versionAgeBucket } = await import("./launchCohort.ts");
const client = await import("./client.ts");
const journeys = await import("./journeys.ts");
const track = await import("./track.ts");
after(() => client.setSharing(false, "settings"));

test("a new version starts its age at this launch and counts this launch as its first cold one only when the Mac restarted since the last launch", () => {
  const saved = { lastLaunchAt: 1_000, versionSince: 50, versionColdLaunches: 7 };
  assert.deepEqual(nextLaunchCohort(saved, true, 5_000, 2_000), { versionSince: 5_000, versionColdLaunches: 1, coldNth: 1 });
  assert.deepEqual(nextLaunchCohort(saved, true, 5_000, 500), { versionSince: 5_000, versionColdLaunches: 0, coldNth: null });
  assert.deepEqual(nextLaunchCohort({ ...saved, lastLaunchAt: null }, true, 5_000, 2_000), { versionSince: 5_000, versionColdLaunches: 0, coldNth: null });
});

test("later launches of a version count up its cold launches and keep a warm launch out of the count", () => {
  const saved = { lastLaunchAt: 1_000, versionSince: 50, versionColdLaunches: 2 };
  assert.deepEqual(nextLaunchCohort(saved, false, 5_000, 2_000), { versionSince: 50, versionColdLaunches: 3, coldNth: 3 });
  assert.deepEqual(nextLaunchCohort(saved, false, 5_000, 500), { versionSince: 50, versionColdLaunches: 2, coldNth: null });
  assert.deepEqual(nextLaunchCohort(saved, false, 5_000, null), { versionSince: 50, versionColdLaunches: 2, coldNth: null });
});

test("a copy that updated before the count existed sends no count or age until its next version, rather than a wrong one", () => {
  const saved = { lastLaunchAt: 1_000, versionSince: null, versionColdLaunches: null };
  assert.deepEqual(nextLaunchCohort(saved, false, 5_000, 2_000), { versionSince: null, versionColdLaunches: null, coldNth: null });
});

test("the buckets are enums only: 1, 2, 3+ and day ranges, null when unknown", () => {
  assert.deepEqual([null, 0, 1, 2, 3, 40].map(coldNthBucket), [null, null, "1", "2", "3+", "3+"]);
  const at = 10 * DAY;
  assert.deepEqual([at, at - DAY / 2, at - DAY, at - 3 * DAY, at - 6 * DAY, at - 7 * DAY, at - 90 * DAY].map((since) => versionAgeBucket(since, at)), [
    "<1d", "<1d", "<2d", "<4d", "<7d", "7d+", "7d+",
  ]);
  assert.equal(versionAgeBucket(null, at), null);
  assert.equal(versionAgeBucket(at + 1, at), null);
});

test("a cold launch three days into a version sends cold_nth 2 and version_age <4d, and saves the count for the next launch", async () => {
  client.loadChoice();
  const session = client.startClient();
  assert.equal(session.coldNth, 2);
  assert.equal(JSON.parse(stub.docs.get("telemetry.json")).versionColdLaunches, 2);
  journeys.startJourneys(session);
  journeys.launchCommitted(client.consentNow());
  const deadline = Date.now() + 10_000;
  while (journeys.devJourneys().pending[0]?.usable === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  track.markFirstWindow();
  journeys.emitJourneys();
  journeys.journeysEnding();

  await client.saveQueueNow();
  const launches = JSON.parse(stub.docs.get("telemetry-queue.json")).events.filter((e) => e.event === "perf_launch");
  assert.equal(launches.length, 1);
  const { cold, cold_nth, version_age, first_of_version } = launches[0].properties;
  assert.deepEqual([cold, cold_nth, version_age, first_of_version], [true, "2", "<4d", false]);
});
