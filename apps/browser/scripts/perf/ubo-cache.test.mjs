import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { engineSaved, storeBytes, uboStoreDir, UBO_ENGINE_KEY_SETS, UBO_ENGINE_KEYS, UBO_ID } from "./ubo-cache.mjs";

test("the engine counts as saved only when all three selfies are in both storage.local and uBO's IndexedDB", () => {
  assert.equal(engineSaved(), false);
  assert.equal(engineSaved({ local: ["compiledMagic", "selfieMagic"], indexedDB: [] }), false);
  assert.equal(engineSaved({ local: UBO_ENGINE_KEYS.slice(0, 2), indexedDB: UBO_ENGINE_KEYS }), false);
  assert.equal(engineSaved({ local: UBO_ENGINE_KEYS, indexedDB: [] }), false);
  assert.equal(engineSaved({ local: UBO_ENGINE_KEYS, indexedDB: UBO_ENGINE_KEYS.slice(1) }), false);
  assert.equal(engineSaved({ local: [...UBO_ENGINE_KEYS, "selfieMagic"], indexedDB: UBO_ENGINE_KEYS }), true);
});

test("Ardia's uBO saves its engine under its own selfie names (ubo.sh renames them), and those count too, but never a mix", () => {
  const [stock, ardia] = UBO_ENGINE_KEY_SETS;
  assert.deepEqual(ardia, ["cache/selfie/staticArdia2Main", "cache/selfie/staticArdia2NetFilteringEngine", "cache/selfie/staticArdia2ExtFilteringEngine"]);
  assert.equal(engineSaved({ local: ardia, indexedDB: ardia }), true);
  assert.equal(engineSaved({ local: ardia, indexedDB: stock }), false);
  assert.equal(engineSaved({ local: [ardia[0], ...stock.slice(1)], indexedDB: [ardia[0], ...stock.slice(1)] }), false);
});

test("the store is uBO's own extension settings folder, and its size is the sum of its files", () => {
  const data = mkdtempSync(join(tmpdir(), "ubo-cache-"));
  try {
    const dir = uboStoreDir(data);
    assert.ok(dir.endsWith(join("Default", "Local Extension Settings", UBO_ID)));
    assert.equal(storeBytes(dir), 0);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "000003.log"), "x".repeat(10));
    writeFileSync(join(dir, "000004.ldb"), "y".repeat(5));
    assert.equal(storeBytes(dir), 15);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
