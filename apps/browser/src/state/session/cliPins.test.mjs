import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { SESSION_VERSION, flushPersistence, startPersistence } from "./persist.ts";
import { docs } from "../../test-native/index.ts";

test("saved pin ownership survives loaded, sleeping and parked pages", () => {
  docs.clear();
  const stop = startPersistence();
  const S = () => useBrowser.getState();
  const read = () => {
    flushPersistence();
    const session = JSON.parse(docs.get("session.json"));
    assert.equal(session.version, SESSION_VERSION);
    return session;
  };
  try {
    const window = S().createWindow({ url: "https://mail.test/" });
    const tile = S().windows[window].tabIds[0];
    S().pinTabs([tile], true);
    const school = S().createSpace({ name: "School", profileId: "default" });
    const row = S().newTab(window, { spaceId: school, url: "https://notes.test/" });
    S().pinTabs([row], true, true);
    const members = [1, 2].map((n) => S().newTab(window, { spaceId: school, url: `https://folder.test/${n}` }));
    const group = S().createGroup(members, { name: "School Folder" });
    S().updateGroup(group, { pinned: true });
    S().createWindow({ spaceId: school });
    const work = S().createProfile({ name: "Work" });
    S().updateProfile("default", { name: "Personal" });
    useBrowser.setState({ topApps: { ...S().topApps, [work]: [{ ...S().topApps.default[0], url: "https://work.test/" }] } });
    const loaded = read();
    assert.equal(loaded.topApps.default[0].url, "https://mail.test/");
    assert.equal(loaded.topApps[work][0].url, "https://work.test/");
    assert.equal(loaded.spaces[school].profileId, "default");
    assert.equal(loaded.tabs.find((tab) => tab.id === row).spaceId, school);
    assert.equal(loaded.groups.find((entry) => entry.id === group).spaceId, school);
    useBrowser.setState({ tabs: Object.fromEntries(Object.entries(S().tabs).map(([id, tab]) => [id, tab.pin?.as === "tile" ? { ...tab, page: { kind: "asleep" } } : tab])) });
    assert.ok(read().tabs.filter((tab) => tab.pin?.as === "tile").every((tab) => tab.page.kind === "asleep"));
    for (const id of [...S().windowOrder]) S().closeWindow(id);
    const parked = read();
    assert.equal(parked.topApps.default[0].url, "https://mail.test/");
    assert.equal(parked.topApps[work][0].url, "https://work.test/");
    assert.ok(parked.parkedPins[school].tabs.some((tab) => tab.url === "https://notes.test/"));
  } finally { stop(); }
});
