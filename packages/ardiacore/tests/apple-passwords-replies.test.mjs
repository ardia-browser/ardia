import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";
import { runSwiftTests } from "./swift-testing.mjs";

const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const hostile = JSON.stringify(HOSTILE_VALUES.map(({ id, value }) => (typeof value === "string" ? { id, units: units(value) } : { id, value: value === undefined ? null : value })));

test("B3: hostile replies from Apple's helper (frames, login names, sites, passwords, codes, Pairing rounds) are dropped or kept within the reply contract", { skip: process.platform !== "darwin" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-hostile-"));
  const file = join(dir, "hostile.json");
  writeFileSync(file, hostile);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  runSwiftTests(t, "apple-passwords-replies-test", ["../ios/ApplePasswordsMatch.swift", "../ios/ApplePasswordsPipe.swift", "../ios/ApplePasswordsSRP.swift", "../ios/ApplePasswordsSRP+Sealing.swift", "./apple-passwords-replies.test.swift"], {
    env: { ARDIA_HOSTILE_JSON_FILE: file },
  });
});
