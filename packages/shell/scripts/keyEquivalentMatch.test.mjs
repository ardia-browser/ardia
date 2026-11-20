import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";
const mainMenu = readFileSync(path("../ios/MainMenu.swift"), "utf8");
const shortcuts = readFileSync(path("../ios/MainMenu+Shortcuts.swift"), "utf8");

test("Quit and Settings pressed ahead of a tab switch are matched the way the menu bar matches them", () => {
  assert.match(mainMenu, /guard appWide, KeyEquivalentMatch\.matches\(item, event\) else \{ continue \}\n\s+return item/);
  assert.equal(mainMenu.includes("item.keyEquivalent == event.charactersIgnoringModifiers"), false, "an uppercase key equivalent carries its Shift");
  assert.match(shortcuts, /KeyEquivalentMatch\.normalized\(key: item\.keyEquivalent, mask: item\.keyEquivalentModifierMask\)/, "one reading of a menu item's shortcut");
});

test("a key equivalent matches a key press as AppKit matches it", (t) => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-key-equivalent-"));
  try {
    const binary = join(dir, "key-equivalent-test");
    const built = spawnSync(swiftc, ["-parse-as-library", path("../ios/KeyEquivalentMatch.swift"), path("./keyEquivalentMatch.test.swift"), "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
