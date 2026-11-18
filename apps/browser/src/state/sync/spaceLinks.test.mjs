import assert from "node:assert/strict";
import { test } from "node:test";

let sequence = 0;
globalThis.acTestNativeModules = { ArdiaSync: { newDeviceId: () => `new-${++sequence}` } };
const { useBrowser } = await import("../browser/store.ts");
const { emptyScope } = await import("@ardia/sync");
const { APP_SCOPE, emptyDoc } = await import("./syncDoc.ts");
const { addLinkedSpace, enableSpace, linkSpaces, readyToPair, sharedDataChain, spaceOwnerMatches } = await import("./spaceLinks.ts");
const { spacesAdapter } = await import("./spaceAdapters.ts");
const S = () => useBrowser.getState();
const record = (v) => ({ h: "stamp", v, o: ["remote", 1] });
const home = { n: "Home", c: "plum", i: null, d: true };
const work = { n: "Work", c: "blue", i: null };

function fixture(records = {}, additional = {}) {
  S().hydrate({});
  const app = { ...emptyScope(), joined: true, records };
  const doc = { ...emptyDoc(), enabled: true, setupAt: Date.now(), scopes: { [APP_SCOPE]: app }, ...additional };
  return { app, doc };
}

test("a joining desktop waits for the default Space and its browsing owner", () => {
  const { app, doc } = fixture({ "prof:work": record(work) }, { joining: true });
  assert.equal(readyToPair(doc, app), false);
  linkSpaces(doc, app);
  assert.equal(doc.spaces.default, undefined);
  app.records["prof:home"] = record(home);
  app.records["share:home"] = record({ o: "owner" });
  assert.equal(readyToPair(doc, app), false);
  app.records["prof:owner"] = record({ ...work, n: "Owner" });
  app.pending = 1;
  assert.equal(readyToPair(doc, app), false);
  app.pending = 0;
  assert.equal(readyToPair(doc, app), true);
  linkSpaces(doc, app);
  assert.equal(doc.spaces.default.syncId, "home");
  assert.equal(doc.spaces.default.ownerSyncId, "owner");
  assert.equal(doc.profiles.default.syncId, "owner");
  assert.ok(doc.scopes["p:home"].awaitRemote && doc.scopes["p:owner"].awaitRemote);
});

test("an empty existing sync folder can start after the pairing deadline", () => {
  const { app, doc } = fixture({}, { joining: true, setupAt: Date.now() - 2 * 86400000 });
  assert.equal(readyToPair(doc, app), true);
  linkSpaces(doc, app);
  assert.equal(doc.spaces.default.syncId, doc.profiles.default.syncId);
  assert.equal(doc.initialized, true);
});

test("a malformed sharing record or unavailable owner holds the Space back", () => {
  const { app, doc } = fixture({ "prof:home": record(home), "prof:work": record(work) });
  for (const bad of [{ o: 1 }, { o: "" }, { o: "missing" }]) {
    app.records["share:work"] = record(bad);
    assert.equal(sharedDataChain(doc, "work").owner, undefined);
    assert.equal(addLinkedSpace(doc, "work"), null);
    assert.equal(S().spaceOrder.length, 1);
  }
  app.records["share:work"] = record({ o: "home" });
  assert.equal(sharedDataChain(doc, "work").owner, "home");
});

test("adding a remote Space reuses its owner and keeps new browsing data off", () => {
  const { doc } = fixture({
    "prof:home": record(home), "prof:work": record(work), "share:work": record({ o: "home" }),
    "identity:home": record({ n: "Personal identity", i: null }), "pta:work": record({ on: false }),
  });
  const workId = addLinkedSpace(doc, "work");
  const homeId = addLinkedSpace(doc, "home");
  const profileId = S().spaces[workId].profileId;
  assert.equal(profileId, S().spaces[homeId].profileId);
  assert.equal(S().profiles[profileId].name, "Personal identity");
  assert.equal(doc.profiles[profileId].enabled, false);
  assert.equal(S().spaces[workId].legacyTopApps, true);
  assert.equal(S().spaces[workId].shareTopApps, undefined);
  assert.equal(addLinkedSpace(doc, "work"), null);
});

test("a local Space remains unlinked after initialization until its own switch is turned on", () => {
  const { app, doc } = fixture();
  linkSpaces(doc, app);
  const localProfile = S().createProfile({ name: "Second" });
  const local = S().createSpace({ name: "Local", profileId: localProfile });
  linkSpaces(doc, app);
  assert.equal(doc.spaces[local], undefined);
  assert.ok(enableSpace(doc, local));
  assert.equal(doc.spaces[local].ownerSyncId, doc.spaces[local].syncId);
  assert.equal(doc.profiles[localProfile].enabled, false);
  S().assignSpaceProfile(local, "default");
  assert.equal(S().spaces[local].profileId, localProfile);
  S().deleteProfile(localProfile, "default");
  assert.ok(S().profiles[localProfile]);
});

test("a changed remote owner blocks the existing binding without reassigning local data", () => {
  const { app, doc } = fixture({ "prof:home": record(home), "prof:work": record(work), "share:work": record({ o: "home" }) });
  const id = addLinkedSpace(doc, "work");
  const profileId = S().spaces[id].profileId;
  assert.ok(spaceOwnerMatches(doc, id));
  app.records["share:work"] = record(null);
  assert.equal(spaceOwnerMatches(doc, id), false);
  linkSpaces(doc, app);
  assert.equal(S().spaces[id].profileId, profileId);
  assert.equal(doc.spaces[id].ownerSyncId, "home");
});

test("a linked workspace adopts an old client's name and publishes the old record shape", () => {
  const { doc } = fixture({ "prof:home": record(home) }, { joining: true });
  linkSpaces(doc, doc.scopes[APP_SCOPE]);
  const adapter = spacesAdapter(() => doc.spaces);
  adapter.apply(new Map([["prof:home", home]]), new Set(["prof:home"]), () => undefined, { known: () => false });
  assert.equal(S().spaces.default.name, "Home");
  S().updateSpace("default", { name: "Renamed" });
  const extracted = adapter.extract(() => undefined, () => false, Date.now(), () => true, () => home);
  assert.deepEqual(extracted.values.get("prof:home"), { n: "Renamed", c: "plum", i: null, d: true });
});
