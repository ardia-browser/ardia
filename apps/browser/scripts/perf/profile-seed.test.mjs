import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettings, profileSeed } from "./profile-seed.mjs";

for (const count of [2, 4, 8, 16]) {
  test(`${count} profiles: one window on Personal and one unloaded local tab per profile`, () => {
    const seed = profileSeed("http://127.0.0.1:9000", count);
    assert.equal(Object.keys(seed.profiles).length, count);
    assert.deepEqual(seed.profileOrder, Object.keys(seed.profiles));
    assert.equal(seed.windows.length, 1);
    assert.equal(seed.windows[0].profileId, "default");
    assert.equal(seed.tabs.length, count);
    assert.equal(new Set(seed.tabs.map((tab) => tab.profileId)).size, count);
    assert.ok(seed.tabs.every((tab) => tab.url.startsWith("http://127.0.0.1:9000/static?id=profile-")));
    assert.deepEqual(Object.keys(seed.windows[0].activeTabIds), seed.profileOrder);
  });
}

test("fewer than two profiles is refused", () => {
  for (const count of [1, 0, -1, 1.5, NaN, Infinity]) assert.throws(() => profileSeed("http://localhost", count));
});

test("the settings given are the only difference between two sides' fixtures", () => {
  const unloading = profileSeed("http://127.0.0.1:9000", 8, parseSettings(["unloadProfilesAfter=5m"]));
  const control = profileSeed("http://127.0.0.1:9000", 8, parseSettings(["unloadProfilesAfter=never"]));
  assert.equal(unloading.settings.unloadProfilesAfter, "5m");
  unloading.settings.unloadProfilesAfter = "never";
  assert.deepEqual(unloading, control);
});

test("setting values parse as JSON, and anything else stays a string", () => {
  assert.deepEqual(parseSettings(["loadProfilesWhenOpened=false", "unloadProfilesAfter=5m", "sidebarWidth=300", "a=b=c"]),
    { loadProfilesWhenOpened: false, unloadProfilesAfter: "5m", sidebarWidth: 300, a: "b=c" });
  assert.throws(() => parseSettings(["nope"]));
});
