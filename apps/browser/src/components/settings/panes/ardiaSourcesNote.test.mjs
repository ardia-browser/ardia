import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));
delete Intl.ListFormat;

await import("../../../test-native/index.ts");
const { ardiaSourcesNote } = await import("./PasswordManagerRow.tsx");

test("the Ardia row names its sources on an engine without Intl.ListFormat, as Hermes is", () => {
  assert.equal(ardiaSourcesNote("ardia", { saved: true, managers: ["1Password", "Bitwarden"] }), "Fills from saved passwords, 1Password and Bitwarden.");
  assert.equal(ardiaSourcesNote("ardia", { saved: false, managers: ["Bitwarden"] }), "Fills from Bitwarden.");
  assert.equal(ardiaSourcesNote("ardia", { saved: false, managers: ["1Password", "Bitwarden"] }), "Fills from 1Password and Bitwarden.");
  assert.equal(ardiaSourcesNote("ardia", { saved: true, managers: [] }), null);
  assert.equal(ardiaSourcesNote("none", { saved: true, managers: ["Bitwarden"] }), null);
});
