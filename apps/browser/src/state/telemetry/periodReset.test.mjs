import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
await import("./usage.ts");
const journeys = await import("./journeys.ts");
const switcher = await import("./switcherPresses.ts");
const popup = await import("./popupProtectedMedia.ts");
const work = await import("./workCounts.ts");
const focusReturns = await import("./pageFocusReturns.ts");
const switcherOpens = await import("./tabSwitcherOpens.ts");
const { consentedCount } = await import("./consentedCount.ts");
const cycles = await import("../sync/cycleWork.ts");
after(() => client.setSharing(false, "settings"));

const sharingOn = () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
};

test("2 resetting the anonymous ID while sharing stays on drops journey state from before the reset", () => {
  sharingOn();
  journeys.startJourneys(null);
  journeys.journeyNavigate("journey-tab");
  assert.ok(journeys.devJourneys().pending.length > 0);
  client.replaceInstallId();
  const after = journeys.devJourneys();
  assert.deepEqual([after.pending.length, Object.keys(after.samples).length, Object.keys(after.counts).length, Object.keys(after.marks).length], [0, 0, 0, 0]);
});

test("2 an identity reset while sharing stays on forgets switcher presses, so a later switch isn't credited to one made before", () => {
  sharingOn();
  switcher.noteSwitcherPress("w", "p", true);
  client.replaceInstallId();
  assert.deepEqual(switcher.switcherSwitchProperties("w", "p"), { via_switcher: false });
});

test("2 an identity reset while sharing stays on zeroes the counters noted before it", async () => {
  sharingOn();
  const counter = consentedCount();
  counter.note();
  popup.notePopupProtectedMedia({ family: "widevine", listed: true, epoch: client.consentEpoch() });
  work.noteLiveSourceFetch(false);
  focusReturns.notePageFocusReturnRequestAfterMenu();
  switcherOpens.noteTabSwitcherReleasedInMenu();
  await cycles.timedCycle(Date.now() - 5, Promise.resolve());
  client.replaceInstallId();
  assert.deepEqual(
    {
      consented: counter.take(),
      popup: popup.takePopupProtectedMediaCounts().popup_protected_media_refused_widevine_listed,
      live: work.takeLiveWorkCounts().live_source_fetches ?? 0,
      focusReturns: focusReturns.takePageFocusReturns().page_focus_return_requests_after_menu,
      menuReleases: switcherOpens.takeTabSwitcherMenuReleases(),
      syncCycles: cycles.takeCycleWork().cycles,
    },
    { consented: 0, popup: 0, live: 0, focusReturns: 0, menuReleases: 0, syncCycles: 0 },
  );
});

test("2 telemetry state that resets at a consent change listens for any change of the consent period, not only the sharing switch", () => {
  const root = new URL("../../../../../", import.meta.url);
  const walk = (dir) =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (entry.name === "node_modules" ? [] : walk(`${dir}${entry.name}/`)) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [`${dir}${entry.name}`] : [],
    );
  const listeners = new Set(["apps/browser/src/state/telemetry/choice.ts", "apps/browser/src/state/telemetry/watchNotice.ts", "apps/linux/src/hostTelemetry.ts"]);
  const offenders = [...walk("apps/browser/src/"), ...walk("apps/linux/src/")]
    .filter((path) => !listeners.has(path))
    .filter((path) => /useTelemetry\.subscribe\(/.test(readFileSync(new URL(path, root), "utf8")));
  assert.deepEqual(offenders, []);
});
