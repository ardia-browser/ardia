import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

const folder = new Map();
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => "devS",
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
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
      return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { S, socketClient, controlOn } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const engine = await import("../sync/engine.ts");

const { ok } = socketClient(23);
const retiring = () => [...shell.docs.values()].some((text) => /"tabsRetire":true/.test(text));

test("profiles.update turning syncTabs off retires the open-tab records, as the Settings switch does", async () => {
  shell.docs.clear();
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  engine.startSync();
  assert.ok("ok" in (await engine.turnOnSync("/sync")));
  await engine.syncNow();
  await controlOn();
  const profile = S().settings.defaultProfileId;
  assert.equal((await ok("profiles.update", { profile, syncTabs: true })).syncTabs, true);
  await engine.syncNow();
  assert.equal((await ok("profiles.update", { profile, syncTabs: false })).syncTabs, false);
  await engine.syncNow();
  assert.ok(retiring(), "the sync document marks the open tabs for retirement");
});
