import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { launch } = await import("../../test-native/index.ts");
const { reloadLaunchConfigForTests } = await import("../../platform/launchConfig.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { useBrowser } = await import("../browser/store.ts");
const { checkMovedTabProfile } = await import("./profileMoveCheck.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

test("a page that never answers fails the moved-tab check with the tab, the step and the time, and the check still closes its windows and removes its profile", async () => {
  launch.test = { httpPages: "9353" };
  reloadLaunchConfigForTests();
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const url = "http://127.0.0.1:9353/a";
  const loaded = JSON.stringify({ href: url, storage: null, cookie: null });
  const page = { evaluate: (code) => (code.includes("setItem") ? new Promise(() => {}) : Promise.resolve(loaded)) };
  const realGet = webviews.get;
  webviews.get = () => page;
  const windowsBefore = S().windowOrder.length;
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let outcome = null;
    void checkMovedTabProfile().then(
      () => (outcome = { passed: true }),
      (error) => (outcome = { error }),
    );
    for (let step = 0; step < 200 && !outcome; step++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(100);
    }
    assert.ok(outcome?.error, `the check fails instead of waiting forever: ${JSON.stringify(outcome)}`);
    assert.match(outcome.error.message, /^the page of tab \S+, seeding the first profile, gave no answer within 5000 ms$/);
    assert.equal(S().windowOrder.length, windowsBefore, "its windows are closed");
    assert.ok(!Object.values(S().profiles).some((profile) => profile.name === "Self-check moved tab"), "its profile is removed");
  } finally {
    mock.timers.reset();
    webviews.get = realGet;
    launch.test = {};
    reloadLaunchConfigForTests();
  }
});
