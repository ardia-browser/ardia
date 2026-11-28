import { asSecret } from "@ardia/core";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `id${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    enterPhrase: async () => ({ ok: true }),
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const client = await import("../telemetry/client.ts");
const { takeSyncWorkCounts } = await import("../telemetry/workCounts.ts");
const S = () => useBrowser.getState();

class Mac {
  constructor() {
    S().hydrate({});
    useBrowser.setState({ bookmarksReady: { "": true } });
    this.browser = S();
    this.docs = new Map();
  }
  async with(fn) {
    useBrowser.setState(this.browser, true);
    shell.docs.clear();
    for (const [k, v] of this.docs) shell.docs.set(k, v);
    try {
      return await fn();
    } finally {
      this.browser = S();
      this.docs = new Map(shell.docs);
    }
  }
}

const THEME = {
  stops: [
    { x: 0.2, y: 0.3, color: { r: 0.3, g: 0.75, b: 0.45, a: 1 } },
    { x: 0.8, y: 0.7, color: { r: 0.85, g: 0.3, b: 0.65, a: 1 } },
  ],
  intensity: 0.8,
  mode: "auto",
  grain: 0.4,
  texture: "grain",
  translucency: 1,
};

async function twoMacs(tag) {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import(`./engine.ts?offA${tag}`);
  const engineB = await import(`./engine.ts?offB${tag}`);
  await a.with(async () => {
    engineA.startSync();
    assert.ok("ok" in (await engineA.turnOnSync("/sync")));
    await engineA.syncNow();
    await engineA.syncNow();
  });
  await b.with(async () => {
    engineB.startSync();
    assert.ok("ok" in (await engineB.enterRecoveryPhrase("/sync", asSecret("syncPhrase", "words"))));
    await engineB.syncNow();
    await engineB.syncNow();
  });
  const rounds = async (n) => {
    for (let i = 0; i < n; i++) {
      await b.with(() => engineB.syncNow());
      await a.with(() => engineA.syncNow());
    }
  };
  await rounds(2);
  return { a, b, engineA, engineB, rounds };
}

const look = () => {
  const p = S().profiles.default;
  return { name: p.name, color: p.color, theme: p.theme ?? null, shareTopApps: !!p.shareTopApps };
};

test("changes made on another Mac while a profile's sync was off arrive when it's turned back on (#3312)", async () => {
  const { a, b, engineA, engineB, rounds } = await twoMacs("1");
  const before = await b.with(look);
  let held, again;
  await b.with(async () => {
    engineB.setProfileSynced("default", false);
    await engineB.syncNow();
  });
  await a.with(async () => {
    S().updateProfile("default", { name: "Elsewhere", color: "green", theme: THEME, shareTopApps: true });
    await engineA.syncNow();
  });
  await b.with(async () => {
    await engineB.syncNow();
    assert.deepEqual(look(), before, "nothing reaches the profile while its sync is off");
    client.setSharing(true, "onboarding");
    takeSyncWorkCounts();
    engineB.setProfileSynced("default", true);
    held = takeSyncWorkCounts().sync_profile_changes_held;
    engineB.setProfileSynced("default", false);
    engineB.setProfileSynced("default", true);
    again = takeSyncWorkCounts().sync_profile_changes_held;
    client.setSharing(false, "settings");
  });
  await rounds(3);
  const changed = { name: "Elsewhere", color: "green", theme: THEME, shareTopApps: true };
  assert.deepEqual(await b.with(look), changed, "the Mac that turned sync back on takes the changes");
  assert.deepEqual(await a.with(look), changed, "and the Mac that made them keeps them");
  assert.equal(held, 3, "the name and colour, the theme and Share Top Apps were held, counted once when sync came back on");
  assert.equal(again, 0, "turning it off and on again before a sync counts nothing more");
});

test("a change made on the Mac whose profile sync was off still goes out when it's turned back on", async () => {
  const { a, b, engineB, rounds } = await twoMacs("2");
  await b.with(async () => {
    engineB.setProfileSynced("default", false);
    await engineB.syncNow();
    S().updateProfile("default", { name: "Offline name" });
    await engineB.syncNow();
  });
  await a.with(async () => assert.notEqual(S().profiles.default.name, "Offline name", "nothing goes out while it's off"));
  await b.with(() => {
    client.setSharing(true, "onboarding");
    takeSyncWorkCounts();
    engineB.setProfileSynced("default", true);
    assert.equal(takeSyncWorkCounts().sync_profile_changes_held, 0, "nothing arrived while it was off, so nothing is counted");
    client.setSharing(false, "settings");
  });
  await rounds(3);
  assert.equal(await a.with(() => S().profiles.default.name), "Offline name");
  assert.equal(await b.with(() => S().profiles.default.name), "Offline name");
});
