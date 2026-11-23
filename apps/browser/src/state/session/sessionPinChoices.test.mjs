import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, SESSION_VERSION, startPersistence } = await import("./persist.ts");
const { SESSION_DOCUMENT } = await import("./sessionDocument.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { Clock } = await import("@ardia/sync");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const stamp = (time) => new Clock("", null, () => time).tick();
const HOME = { home: stamp(1_000), "place:home": stamp(2_000) };
const WORK = { desk: stamp(3_000) };
const profile = (id) => ({ id, name: id, color: "plum", icon: null, createdAt: 0 });
const tab = (id, profileId) => ({ id, windowId: "w1", profileId, url: `https://${id}.example/`, title: id, favicon: null, pin: { as: "tile" }, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "idle" }, openerId: null, createdAt: 0, lastActiveAt: 0 });
const sessionWith = (pinChoices, version = SESSION_VERSION) => ({
  version,
  profiles: { default: profile("default"), work: profile("work") },
  profileOrder: ["default", "work"],
  windows: [{ id: "w1", profileId: "default", tabIds: ["home", "desk"], activeTabIds: { default: "home", work: "desk" }, frame: null, createdAt: 0 }],
  windowOrder: ["w1"],
  tabs: [tab("home", "default"), tab("desk", "work")],
  pinChoices,
});

function launchWith(pinChoices, sharing = false, version = SESSION_VERSION) {
  stub.docs.set(SESSION_DOCUMENT, JSON.stringify(sessionWith(pinChoices, version)));
  setConsentPeriod(sharing, sharing ? "epoch-pin-choices" : null);
  takeSessionWrites();
  const stop = startPersistence();
  try {
    assert.deepEqual(S().windowOrder, ["w1"], "the window is restored");
    assert.deepEqual(Object.keys(S().tabs).sort(), ["desk", "home"], "both pins are restored");
    return { choices: S().pinChoices, counts: takeSessionWrites() };
  } finally {
    stop();
    setConsentPeriod(false, null);
  }
}

const NOT_STRINGS = { zero: 0, time: 1_792_984_216_515, null: null, boolean: true, object: {}, array: [], nested: { h: stamp(4_000) } };
const NOT_MAPS = { null: null, number: 7, boolean: true, string: "stamp", empty: [], list: [stamp(4_000)] };

for (const [shape, bad] of Object.entries(NOT_STRINGS)) {
  test(`a pin choice stamp of shape ${shape} doesn't stop the launch, and the choices beside it are kept`, () => {
    assert.deepEqual(launchWith({ default: { ...HOME, home: bad }, work: WORK }).choices, { default: { "place:home": HOME["place:home"] }, work: WORK });
  });
}

for (const [shape, bad] of Object.entries(NOT_MAPS)) {
  test(`shape ${shape} in place of a profile's pin choices keeps the other profile's`, () => {
    assert.deepEqual(launchWith({ default: bad, work: WORK }).choices, { work: WORK });
  });
}

for (const [shape, bad] of Object.entries({ ...NOT_MAPS, nested: [[0]], holed: [null] })) {
  test(`shape ${shape} in place of every profile's pin choices starts with none`, () => {
    assert.deepEqual(launchWith(bad).choices, {});
  });
}

test("well-formed pin choices load as saved", () => {
  assert.deepEqual(launchWith({ default: HOME, work: WORK }).choices, { default: HOME, work: WORK });
});

test("the next save writes the session without the malformed pin choice", () => {
  stub.docs.set(SESSION_DOCUMENT, JSON.stringify(sessionWith({ default: { ...HOME, home: 0 }, work: WORK })));
  const stop = startPersistence();
  try {
    S().newTab("w1", { url: "https://new.example/" });
    flushPersistence();
    assert.deepEqual(JSON.parse(stub.docs.get(SESSION_DOCUMENT)).pinChoices, { default: { "place:home": HOME["place:home"] }, work: WORK });
  } finally {
    stop();
  }
});

test("a launch that dropped malformed pin choices is counted once, and only while sharing", () => {
  const repairs = (pinChoices, sharing) => launchWith(pinChoices, sharing).counts.session_pin_choice_repairs;
  assert.equal(repairs({ default: { home: 0, "place:home": null }, work: 7 }, true), 1);
  assert.equal(repairs({ default: { home: 0 } }, false), 0);
  assert.equal(repairs({ default: HOME, work: WORK }, true), 0);
  assert.equal(repairs(undefined, true), 0, "a session without choices isn't damaged");
});

test("malformed pin choices the 8 to 9 migration drops are counted once too, and only while sharing", () => {
  const repairs = (pinChoices, sharing, version) => launchWith(pinChoices, sharing, version).counts.session_pin_choice_repairs;
  const dropped = [{ default: { bad: true } }, { default: { bad: true }, work: { bad: null } }, { default: null }, { default: [] }, null, [null]];
  for (let version = 2; version <= SESSION_VERSION; version++) {
    for (const bad of dropped) {
      assert.equal(repairs(bad, true, version), 1, `version ${version}, ${JSON.stringify(bad)}`);
      assert.equal(repairs(bad, false, version), 0, `version ${version}, not sharing`);
    }
    assert.equal(repairs({ default: HOME }, true, version), 0, `version ${version}, stamps`);
    if (version <= 8) assert.equal(repairs({ default: { home: 1_000 } }, true, version), 0, `version ${version}, a time is converted, not dropped`);
  }
});
