import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { passwordsAdapter } = await import("./adapters.ts");

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
  const ok = await adapter.apply(visible, new Set([BLANK]), () => undefined, { held: () => false, landed: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(saved, []);
});
