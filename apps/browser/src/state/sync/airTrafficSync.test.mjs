import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => "devTest",
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async () => "f1",
    read: async () => ({ files: [], pending: [], damaged: [], present: [] }),
    remove: async () => {},
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { appAdapters } = await import("./scopeAdapters.ts");
const { emptyDoc } = await import("./syncDoc.ts");
const { AIR_TRAFFIC_DOC, NO_AIR_TRAFFIC, parseAirTraffic } = await import("../airTraffic/rules.ts");
const air = await import("../airTraffic/store.ts");

const S = () => useBrowser.getState();
const SLACK = { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };
const SYNC_IDS = { Home: "sHome", Work: "sWork", Archive: "sArchive" };

const files = new Map();
let wall = 1_900_000_000_000;
const transport = {
  write: async (scope, payload) => {
    const id = `c${files.size + 1}-${wall}`;
    files.set(id, { scope, payload });
    return id;
  },
  read: async (scope, known) => {
    const here = [...files].filter(([, f]) => f.scope === scope);
    return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
  },
  remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
};

const macOf = (device, names) => {
  S().hydrate({});
  const ids = {};
  for (const name of names) ids[name] = S().createProfile({ name });
  const linked = Object.keys(ids).filter((name) => SYNC_IDS[name]);
  const doc = { ...emptyDoc(), deviceId: device, enabled: true, profiles: Object.fromEntries(linked.map((name) => [ids[name], { syncId: SYNC_IDS[name], enabled: true }])) };
  doc.scopes = { app: { ...emptyScope(), joined: true } };
  return { device, doc, ids, browser: S(), atc: NO_AIR_TRAFFIC, clock: new Clock(device, null, () => ++wall) };
};

const enter = (m) => {
  useBrowser.setState(m.browser, true);
  air.resetAirTrafficForTests(m.atc);
};

const leave = (m) => {
  m.browser = S();
  m.atc = air.currentAirTraffic();
};

const run = async (m, times = 2) => {
  for (let i = 0; i < times; i++) {
    enter(m);
    await syncScope({ scope: "app", state: m.doc.scopes.app, transport, adapters: appAdapters(m.doc, false), clock: m.clock, device: m.device, now: () => wall });
    leave(m);
  }
};

const edit = (m, change) => {
  enter(m);
  change();
  leave(m);
};

const liveIn = (m, key) => m.doc.scopes.app.records[key]?.v != null;
const liveKeys = (m) =>
  Object.entries(m.doc.scopes.app.records)
    .filter(([key, r]) => key.startsWith("atc:") && r.v != null)
    .map(([key]) => key);

const rule = (id, over = {}) => ({ id, enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab", ...over });
const shape = (config) => ({
  rules: config.rules.map((r) => [r.id, r.enabled, r.profileId, r.open]),
  fallback: config.fallback,
  fallbackChosen: config.fallbackChosen ?? false,
});

const setUp = () => {
  files.clear();
  const a = macOf("A", ["Home", "Work", "Scratch"]);
  const b = macOf("B", ["Extra", "Home", "Work"]);
  assert.notEqual(a.ids.Work, b.ids.Work, "the two Macs name the same profile differently");
  a.atc = {
    rules: [
      rule("r1", { from: SLACK, profileId: a.ids.Work, open: "tab" }),
      rule("r2", { when: { kind: "site", host: "example.com" }, profileId: a.ids.Home, open: "window", enabled: false }),
      rule("r3", { when: { kind: "contains", text: "scratch" }, profileId: a.ids.Scratch }),
      rule("r4", { when: { kind: "contains", text: "docs" }, profileId: null, open: "littleArdia" }),
    ],
    fallback: { profileId: a.ids.Work, open: "tab" },
    fallbackChosen: true,
  };
  return { a, b };
};

test("rules and the Everything Else choice follow to another Mac, in order and aimed at that Mac's profiles", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);

  assert.deepEqual(shape(b.atc), {
    rules: [
      ["r1", true, b.ids.Work, "tab"],
      ["r2", false, b.ids.Home, "window"],
      ["r4", true, null, "littleArdia"],
    ],
    fallback: { profileId: b.ids.Work, open: "tab" },
    fallbackChosen: true,
  });
  assert.deepEqual(b.atc.rules[0].from, SLACK);
  assert.deepEqual(b.atc.rules[1].when, { kind: "site", host: "example.com" });
  assert.deepEqual(b.atc.rules[2].when, { kind: "contains", text: "docs" });
  assert.deepEqual(shape(parseAirTraffic(stub.docs.get(AIR_TRAFFIC_DOC))), shape(b.atc), "and air-traffic.json holds the same");
});

test("a rule aimed at a profile that isn't synced stays on its Mac", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);

  assert.ok(!liveKeys(a).includes("atc:r:r3"), "never published");
  assert.ok(a.atc.rules.some((r) => r.id === "r3" && r.profileId === a.ids.Scratch), "and still there on its own Mac");
  assert.ok(!b.atc.rules.some((r) => r.id === "r3"));
});

test("a record aimed at a profile this Mac doesn't have is kept, not dropped", async () => {
  const { a, b } = setUp();
  enter(a);
  a.ids.Archive = S().createProfile({ name: "Archive" });
  leave(a);
  a.doc.profiles[a.ids.Archive] = { syncId: SYNC_IDS.Archive, enabled: true };
  a.atc = { ...a.atc, rules: [...a.atc.rules, rule("r5", { when: { kind: "equals", text: "https://a.test/page" }, profileId: a.ids.Archive })] };
  await run(a);
  await run(b);

  assert.ok(liveIn(a, "atc:r:r5"));
  assert.ok(!b.atc.rules.some((r) => r.id === "r5"), "B has no such profile, so no rule");
  assert.ok(liveIn(b, "atc:r:r5"), "but the record stays");

  edit(b, () => air.removeAirTrafficRule("r4"));
  await run(b);
  await run(a);
  assert.ok(liveIn(a, "atc:r:r5"), "B's own edits don't remove it for A");
  assert.ok(a.atc.rules.some((r) => r.id === "r5" && r.profileId === a.ids.Archive));
  assert.ok(!a.atc.rules.some((r) => r.id === "r4"), "while B's delete of r4 reaches A");
});

test("a delete, a disable and a move on one Mac reach the other", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);

  edit(a, () => {
    air.removeAirTrafficRule("r2");
    air.updateAirTrafficRule("r1", { enabled: false });
    air.moveAirTrafficRule("r4", -1);
  });
  await run(a);
  await run(b);

  assert.deepEqual(
    b.atc.rules.map((r) => [r.id, r.enabled]),
    [
      ["r1", false],
      ["r4", true],
    ],
  );
  assert.equal(b.atc.rules[0].profileId, b.ids.Work);
  assert.ok(!liveKeys(a).includes("atc:r:r2"), "the deleted rule's record is a tombstone");
});

test("a move reaches the other Mac as a new order", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);

  edit(a, () => {
    air.moveAirTrafficRule("r4", -1);
    air.moveAirTrafficRule("r4", -1);
    air.moveAirTrafficRule("r4", -1);
  });
  await run(a);
  await run(b);

  assert.deepEqual(
    b.atc.rules.map((r) => r.id),
    ["r4", "r1", "r2"],
  );
});

test("the Everything Else choice changed on the other Mac comes back to this one", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);

  edit(b, () => air.setAirTrafficFallback({ profileId: b.ids.Home, open: "window" }));
  await run(b);
  await run(a);

  assert.deepEqual(a.atc.fallback, { profileId: a.ids.Home, open: "window" });
  assert.equal(a.atc.fallbackChosen, true);
  assert.deepEqual(
    a.atc.rules.map((r) => r.id),
    ["r1", "r2", "r3", "r4"],
    "A's rules, including the one that stays local, are untouched",
  );
});

test("applying what another Mac published writes nothing back", async () => {
  const { a, b } = setUp();
  await run(a);
  await run(b);
  const airRecords = (m) => JSON.stringify(Object.entries(m.doc.scopes.app.records).filter(([key]) => key.startsWith("atc:")));
  const before = [airRecords(a), airRecords(b)];
  assert.deepEqual(liveKeys(a).sort(), ["atc:fallback", "atc:r:r1", "atc:r:r2", "atc:r:r4"]);

  await run(b, 3);
  await run(a, 3);
  await run(b, 3);

  assert.deepEqual([airRecords(a), airRecords(b)], before, "no later cycle changed an Air Traffic record on either Mac");
});

test("only the new adapter covers atc: records, and none are published with Settings sync off", async () => {
  const { a } = setUp();
  const covering = appAdapters(a.doc, false).filter((adapter) => "atc:r:x".startsWith(adapter.prefix) || "atc:fallback".startsWith(adapter.prefix));
  assert.deepEqual(
    covering.map((adapter) => adapter.prefix),
    ["atc:"],
    "no released prefix starts atc:, so an older Mac leaves the records unapplied",
  );

  a.doc.types = { ...a.doc.types, settings: false };
  assert.deepEqual(
    appAdapters(a.doc, false).filter((adapter) => adapter.prefix.startsWith("atc:")),
    [],
  );
  await run(a);
  assert.deepEqual(liveKeys(a), []);
});
