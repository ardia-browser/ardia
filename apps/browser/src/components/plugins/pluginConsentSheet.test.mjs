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
  assert.match(sheet, /consentLines\(m, \{ controlOff, official: !!listing\?\.official, movesProfiles \}\)/);
  assert.match(settingsRow, /movesProfiles/);
  useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  assert.equal(neverChosenCount(), 1);
  const lines = consentLines(manifest, { official: true, movesProfiles: neverChosenCount() }).map((l) => l.text);
  assert.ok(lines.some((text) => /^Moves 1 profile that never picked a password manager to /.test(text)), lines.join("\n"));
});
