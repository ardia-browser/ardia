import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("Windows hides the settings whose only effect is an engine call it doesn't have", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const windowsFeatures = source("../../lib/platformFeatures.windows.ts");
  const macFeatures = source("../../lib/platformFeatures.ts");
  const missing = JSON.parse(source("../../../../../packages/expo-windows/src/engine/domains/forwarded.json")).missing;
  const flags = { keepsNewTabLinksInLittleArdia: [false, true], commandScrollZoom: [false, true], passwordAutofillSwitch: [false, true], blocksAutoplayEverywhere: [false, true] };
  for (const [flag, [onWindows, onMac]] of Object.entries(flags)) {
    assert.match(windowsFeatures, new RegExp(`${flag}: ${onWindows}\\b`), `Windows ${flag}`);
    assert.match(macFeatures, new RegExp(`${flag}: ${onMac}\\b`), `Mac ${flag}`);
  }
  assert.ok(missing.webView.includes("setLittleArdiaOpensNewTabLinks"));
  assert.ok(missing.webView.includes("setCommandScrollZoom"));
  assert.ok(missing.webView.includes("setBlockAutoplayEverywhere"));
  assert.ok(missing.passwords.includes("setAutofillEnabled") && missing.passwords.includes("autofillEnabled"));
  const rows = source("./rows/generalRows.ts") + source("./rows/privacyRows.ts");
  for (const [row, flag] of [["littleArdiaOpensNewTabLinks", "keepsNewTabLinksInLittleArdia"], ["commandScrollZoom", "commandScrollZoom"], ["offerToSave", "passwordAutofillSwitch"], ["blockAutoplayEverywhere", "blocksAutoplayEverywhere"]]) {
    assert.match(rows, new RegExp(`${row}: \\{\\n\\s+shown: \\(\\) => PLATFORM_FEATURES\\.${flag},`), row);
  }
});
