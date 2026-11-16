import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { passwordsAdapter } = await import("./adapters.ts");

useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });

const originOf = (host) => `https://${host}.example`;
const keyOf = (host, username) => `pws:${originOf(host)}\n${username}`;
const valueOf = (host, username, sealed) => ({ o: originOf(host), u: username, s: sealed });

const ADA = keyOf("a", "ada");
const BO = keyOf("b", "bo");
const CY = keyOf("c", "cy");
const DEE = keyOf("d", "dee");

function engineLogins() {
  const store = new Map();
  const sealed = new Map();
  stub.current.device = null;
  stub.passwordStores.set(null, store);
  const put = (origin, username, seal, created) => {
    store.set(`${origin}\n${username}`, { origin, url: origin, username, password: "kept by the engine", created });
    sealed.set(`${origin}\n${username}`, seal);
  };
  const saved = [];
  const read = async () => [...store.values()].map((l) => ({ origin: l.origin, username: l.username, sealed: sealed.get(`${l.origin}\n${l.username}`), created: l.created }));
  const save = async (profile, origin, username, seal, replacing) => {
    saved.push([profile, origin, username, seal, replacing]);
    put(origin, username, seal, 9);
    return true;
  };
  return { store, put, saved, logins: { read, save } };
}

test("with only sealed logins, as the Mac always sends, the adapter offers, ignores and writes what it did before passwordless logins", async () => {
  const engine = engineLogins();
  engine.put(originOf("a"), "ada", "sealed-ada", 1);
  engine.put(originOf("b"), "bo", "sealed-bo", 2);
  engine.put(originOf("c"), "cy", "sealed-cy", 3);
  const adapter = passwordsAdapter("default", engine.logins)(true);

  const extracted = await adapter.extract();
  assert.deepEqual([...extracted.values], [
    [ADA, valueOf("a", "ada", "sealed-ada")],
    [BO, valueOf("b", "bo", "sealed-bo")],
    [CY, valueOf("c", "cy", "sealed-cy")],
  ]);
  assert.deepEqual([ADA, BO, CY, DEE].map((key) => extracted.ignore?.(key) ?? false), [false, false, false, false], "nothing is ignored");

  const visible = new Map([[ADA, valueOf("a", "ada", "sealed-ada-new")], [DEE, valueOf("d", "dee", "sealed-dee")]]);
  const base = (key) => ({ [ADA]: valueOf("a", "ada", "sealed-ada"), [BO]: valueOf("b", "bo", "sealed-bo") })[key];
  const applied = await adapter.apply(visible, new Set([ADA, BO, DEE]), base, { held: () => false, landed: () => {} });
  assert.equal(applied, true, "every write succeeded");
  assert.deepEqual(engine.saved, [
    ["", originOf("a"), "ada", "sealed-ada-new", true],
    ["", originOf("d"), "dee", "sealed-dee", false],
  ], "a changed password replaces, a new one is added");
  assert.ok(!engine.store.has(`${originOf("b")}\nbo`), "a login deleted elsewhere is deleted here");
  assert.ok(engine.store.has(`${originOf("c")}\ncy`), "an unchanged login stays");
});
