import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { passwordsAdapter } = await import("./adapters.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");

useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });

const BLANK = "pws:https://a.example\nada";
const KEPT = "pws:https://b.example\nbo";

function adapterWith(saved) {
  const read = async () => [
    { origin: "https://a.example", username: "ada", passwordless: true, created: 1 },
    { origin: "https://b.example", username: "bo", sealed: "sealed-bo", created: 2 },
  ];
  return passwordsAdapter("default", { read, save: async (...args) => (saved.push(args), true) })(true);
}

test("a login the engine lists as passwordless is neither uploaded nor read as a deletion", async () => {
  const extracted = await adapterWith([]).extract();
  assert.deepEqual([...extracted.values.keys()], [KEPT], "only the login with a password is offered to sync");
  assert.equal(extracted.ignore(BLANK), true, "the passwordless login's synced copy is left as it is, not deleted");
  assert.equal(extracted.ignore(KEPT), false);
});

test("a synced password is never written over a login this machine lists as passwordless", async () => {
  const saved = [];
  const adapter = adapterWith(saved);
  await adapter.extract();
  const visible = new Map([[BLANK, { o: "https://a.example", u: "ada", s: "sealed-remote" }]]);
  const ok = await adapter.apply(visible, new Set([BLANK]), () => undefined, { held: () => false, landed: () => {}, defer: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(saved, []);
});

test("a login the Mac couldn't seal, listed as passwordless, publishes no deletion; a login really gone still does", async () => {
  const files = new Map();
  let counter = 0;
  const transport = {
    write: async (_scope, payload) => (files.set(`f${++counter}`, payload), `f${counter}`),
    read: async (_scope, known) => ({ files: [...files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending: [], damaged: [], present: [...files.keys()] }),
    remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
  };
  const ada = { origin: "https://a.example", username: "ada", sealed: "sealed-ada", created: 1 };
  const bo = { origin: "https://b.example", username: "bo", sealed: "sealed-bo", created: 2 };
  let listed = [ada, bo];
  const adapter = passwordsAdapter("default", { read: async () => listed, save: async () => true });
  const state = emptyScope();
  const clock = new Clock("mac");
  let now = 1_000_000;
  const cycle = () => syncScope({ scope: "p", state, transport, adapters: [adapter(true)], clock, device: "mac", now: () => (now += 60_000) });
  const deletions = () => [...files.values()].flatMap((payload) => JSON.parse(payload).ops ?? []).filter((op) => op.v === null).map((op) => op.k);
  await cycle();
  assert.deepEqual(deletions(), []);
  listed = [{ origin: ada.origin, username: ada.username, passwordless: true, created: ada.created }, bo];
  await cycle();
  assert.deepEqual(deletions(), [], "a login whose password couldn't be sealed this time is left as it is everywhere");
  listed = [bo];
  await cycle();
  assert.deepEqual(deletions(), [BLANK], "a login deleted on this Mac is still deleted everywhere, as before");
});

function sharedFolder() {
  const files = new Map();
  let counter = 0;
  return {
    files,
    transport: {
      write: async (_scope, payload) => (files.set(`f${++counter}`, payload), `f${counter}`),
      read: async (_scope, known) => ({ files: [...files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending: [], damaged: [], present: [...files.keys()] }),
      remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
    },
    opsFor: (key) => [...files.values()].flatMap((payload) => JSON.parse(payload).ops ?? []).filter((op) => op.k === key),
  };
}

function thisMac() {
  const store = new Map();
  const sealed = new Map();
  stub.current.device = null;
  stub.passwordStores.set(null, store);
  const state = { unavailable: false, saved: [] };
  const id = (origin, username) => `${origin}\n${username}`;
  state.put = (origin, username, seal) => {
    store.set(id(origin, username), { origin, url: origin, username, password: "kept by the engine", created: 1 });
    sealed.set(id(origin, username), seal);
  };
  state.sealedOf = (origin, username) => (store.has(id(origin, username)) ? sealed.get(id(origin, username)) : undefined);
  state.logins = {
    read: async () => [...store.values()].map((l) => (state.unavailable ? { origin: l.origin, username: l.username, passwordless: true, created: l.created } : { origin: l.origin, username: l.username, sealed: sealed.get(id(l.origin, l.username)), created: l.created })),
    save: async (_profile, origin, username, seal) => (state.saved.push(seal), state.put(origin, username, seal), true),
  };
  return state;
}

function otherDevice() {
  const logins = new Map();
  return {
    logins,
    adapter: passwordsAdapter("default", {
      read: async () => [...logins.values()],
      save: async (_profile, origin, username, seal) => (logins.set(`${origin}\n${username}`, { origin, username, sealed: seal, created: 5 }), true),
    }),
  };
}

async function twoDevices() {
  const folder = sharedFolder();
  const mac = thisMac();
  mac.put("https://a.example", "ada", "sealed-original");
  const other = otherDevice();
  let now = 2_000_000;
  const devices = {
    mac: { state: emptyScope(), clock: new Clock("mac"), adapter: passwordsAdapter("default", mac.logins) },
    other: { state: emptyScope(), clock: new Clock("other"), adapter: other.adapter },
  };
  const cycle = (name) => syncScope({ scope: "p", state: devices[name].state, transport: folder.transport, adapters: [devices[name].adapter(true)], clock: devices[name].clock, device: name, now: () => (now += 60_000) });
  await cycle("mac");
  await cycle("other");
  assert.equal(other.logins.get("https://a.example\nada")?.sealed, "sealed-original", "the other device has the login");
  return { folder, mac, other, cycle };
}

test("a remote change to a login this Mac couldn't read waits, then lands once it can, and the old password is never republished", async () => {
  const { folder, mac, other, cycle } = await twoDevices();
  other.logins.set("https://a.example\nada", { origin: "https://a.example", username: "ada", sealed: "sealed-changed-elsewhere", created: 5 });
  await cycle("other");
  mac.unavailable = true;
  await cycle("mac");
  assert.deepEqual(mac.saved, [], "nothing is written over a login this Mac can't read");
  mac.unavailable = false;
  await cycle("mac");
  assert.equal(mac.sealedOf("https://a.example", "ada"), "sealed-changed-elsewhere", "the remote change lands once the login reads again");
  await cycle("other");
  assert.equal(other.logins.get("https://a.example\nada")?.sealed, "sealed-changed-elsewhere", "the other device keeps its change");
  assert.deepEqual(folder.opsFor(BLANK).map((op) => op.v?.s ?? null), ["sealed-original", "sealed-changed-elsewhere"], "the old password was never published again");
});

test("a remote deletion of a login this Mac couldn't read waits, then deletes it here once it can, and is never reversed", async () => {
  const { folder, mac, other, cycle } = await twoDevices();
  other.logins.delete("https://a.example\nada");
  await cycle("other");
  mac.unavailable = true;
  await cycle("mac");
  assert.equal(mac.sealedOf("https://a.example", "ada"), "sealed-original", "nothing is deleted while the login can't be read");
  mac.unavailable = false;
  await cycle("mac");
  assert.equal(mac.sealedOf("https://a.example", "ada"), undefined, "the remote deletion lands once the login reads again");
  await cycle("other");
  assert.equal(other.logins.has("https://a.example\nada"), false, "the other device's deletion stays");
  assert.deepEqual(folder.opsFor(BLANK).map((op) => op.v?.s ?? null), ["sealed-original", null], "the deleted login was never published again");
});

test("a login edited here while a remote change waited still wins, as any newer local edit does", async () => {
  const { folder, mac, other, cycle } = await twoDevices();
  other.logins.set("https://a.example\nada", { origin: "https://a.example", username: "ada", sealed: "sealed-changed-elsewhere", created: 5 });
  await cycle("other");
  mac.unavailable = true;
  await cycle("mac");
  mac.unavailable = false;
  mac.put("https://a.example", "ada", "sealed-edited-here");
  await cycle("mac");
  assert.equal(mac.sealedOf("https://a.example", "ada"), "sealed-edited-here");
  assert.equal(folder.opsFor(BLANK).at(-1)?.v?.s, "sealed-edited-here");
});
