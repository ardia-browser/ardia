import assert from "node:assert/strict";
import { test } from "node:test";
import { probeOnboardingSystem } from "./systemProbe.ts";

const failed = () => Promise.reject(new Error("unavailable"));
const probes = (overrides = {}) => ({
  isDefaultBrowser: async () => false,
  isInDock: async () => false,
  launchAtLoginStatus: async () => "notRegistered",
  ...overrides,
});

test("onboarding reads the default browser, Dock and login item when every check answers", async () => {
  assert.deepEqual(
    await probeOnboardingSystem(probes({ isDefaultBrowser: async () => true, isInDock: async () => true, launchAtLoginStatus: async () => "enabled" })),
    { isDefault: true, inDock: true, dockAvailable: true, loginEnabled: true },
  );
});

test("a failed default browser check never claims Ardia is already the default, and onboarding still settles", async () => {
  const system = await probeOnboardingSystem(probes({ isDefaultBrowser: failed }));
  assert.equal(system.isDefault, false);
  assert.equal(system.dockAvailable, true);
});

test("a failed Dock check leaves the Dock option out instead of holding onboarding", async () => {
  const system = await probeOnboardingSystem(probes({ isInDock: failed }));
  assert.deepEqual(system, { isDefault: false, inDock: false, dockAvailable: false, loginEnabled: false });
});

test("a failed login item check reads as not registered", async () => {
  const system = await probeOnboardingSystem(probes({ isDefaultBrowser: failed, isInDock: failed, launchAtLoginStatus: failed }));
  assert.deepEqual(system, { isDefault: false, inDock: false, dockAvailable: false, loginEnabled: false });
});
