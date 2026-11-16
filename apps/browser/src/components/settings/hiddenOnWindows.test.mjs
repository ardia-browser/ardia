import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("Windows hides the settings whose only effect is an engine call it doesn't have", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const windowsFeatures = source("../../lib/platformFeatures.windows.ts");
  const macFeatures = source("../../lib/platformFeatures.ts");
  const missing = JSON.parse(source("../../../../../packages/expo-windows/src/engine/domains/forwarded.json")).missing;
  const flags = { keepsNewTabLinksInLittleArdia: [false, true], commandScrollZoom: [false, true], passwordAutofillSwitch: [false, true], blocksAutoplay: [false, true], answersPermissionRequests: [false, true] };
  for (const [flag, [onWindows, onMac]] of Object.entries(flags)) {
    assert.match(windowsFeatures, new RegExp(`${flag}: ${onWindows}\\b`), `Windows ${flag}`);
    assert.match(macFeatures, new RegExp(`${flag}: ${onMac}\\b`), `Mac ${flag}`);
  }
  assert.ok(missing.webView.includes("setLittleArdiaOpensNewTabLinks"));
  assert.ok(missing.webView.includes("setCommandScrollZoom"));
  assert.ok(missing.webView.includes("setBlockAutoplayEverywhere"));
  assert.ok(missing.passwords.includes("setAutofillEnabled") && missing.passwords.includes("autofillEnabled"));
  const rows = source("./rows/generalRows.ts") + source("./rows/privacyRows.ts");
  for (const [row, flag] of [["littleArdiaOpensNewTabLinks", "keepsNewTabLinksInLittleArdia"], ["commandScrollZoom", "commandScrollZoom"], ["offerToSave", "passwordAutofillSwitch"], ["blockAutoplayEverywhere", "blocksAutoplay"], ["blockNotificationRequests", "answersPermissionRequests"]]) {
    assert.match(rows, new RegExp(`${row}: \\{\\n\\s+shown: \\(\\) => PLATFORM_FEATURES\\.${flag},`), row);
  }
  assert.match(source("../../state/site/siteControls.ts"), /offersSiteSetting = \(type: SiteSettingType\) => type !== "autoplay" \|\| PLATFORM_FEATURES\.blocksAutoplay;/);
  const privacy = source("./panes/Privacy.tsx");
  assert.match(privacy, /\{\(PLATFORM_FEATURES\.blocksAutoplay \|\| PLATFORM_FEATURES\.answersPermissionRequests\) && \(\s*<>\s*<SectionHeader title="All sites"/);
  assert.match(privacy, /\{PLATFORM_FEATURES\.answersPermissionRequests && <SettingToggle anchor="privacy\.blockNotificationRequests" \/>\}/);
  assert.ok(missing.permissions.includes("resolve"));
  assert.match(rows, /popupsOpenAsTabs: \{\n\s+title: "Open pop-up windows as tabs",/, "Windows opens pop-ups as tabs itself, so the row shows there");
  assert.match(privacy, /SETTING_LABELS\.filter\(\(\[type\]\) => settings\?\.\[type\] && offersSiteSetting\(type\)\)/);
});
