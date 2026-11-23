import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../../state/browser/store.ts");
const { consentLines } = await import("../../state/plugins/actions.ts");
const { neverChosenCount } = await import("../../state/site/passwordManager.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");

const sheet = readFileSync(new URL("./PluginConsentSheet.tsx", import.meta.url), "utf8");
const settingsRow = readFileSync(new URL("../settings/panes/Plugins.tsx", import.meta.url), "utf8");
const manifest = readManifest(readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8")).manifest;

test("the shared consent sheet tells you which never-chosen profiles a built-in password manager takes over, as Settings does", () => {
  assert.match(sheet, /useNeverChosenCount\(\)/);
  assert.match(sheet, /consentLines\(m, \{ controlOff, official: !!live\?\.official, movesProfiles \}\)/);
  assert.match(settingsRow, /movesProfiles/);
  useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  assert.equal(neverChosenCount(), 1);
  const lines = consentLines(manifest, { official: true, movesProfiles: neverChosenCount() }).map((l) => l.text);
  assert.ok(lines.some((text) => /^Moves 1 profile to .+\. It never picked a password manager$/.test(text)), lines.join("\n"));
});

test("Settings lists what a plugin gets in the sheet's groups and rows, with its own sentence-case headers", async () => {
  const { groupedConsent, CONSENT_SETTINGS_TITLES } = await import("../../state/plugins/consentLine.ts");
  const lines = consentLines(manifest, { official: true, movesProfiles: 0 });
  const sheetGroups = groupedConsent(lines);
  const settingsGroups = groupedConsent(lines, CONSENT_SETTINGS_TITLES);
  assert.deepEqual(settingsGroups.map((g) => g.group), sheetGroups.map((g) => g.group));
  assert.deepEqual(settingsGroups.map((g) => g.lines), sheetGroups.map((g) => g.lines), "the same rows in the same order");
  for (const g of settingsGroups) assert.equal(g.title, g.title[0] + g.title.slice(1).toLowerCase(), `${g.title} is sentence case`);
  assert.deepEqual(settingsGroups.map((g) => g.title), ["What it does"]);
  assert.ok(settingsGroups[0].lines.every((l) => l.detail && !l.title.includes(l.detail)), "each row keeps its title and its detail apart");
  assert.match(settingsRow, /<PluginConsentRows lines=\{consentLines\(m, /);
  assert.doesNotMatch(settingsRow, /title=\{line\.text\}/, "Settings no longer shows each line flattened into one string");
});
