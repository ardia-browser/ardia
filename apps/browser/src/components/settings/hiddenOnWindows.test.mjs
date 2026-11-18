import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("Windows hides the settings whose only effect is an engine call it doesn't have, and shows autoplay blocking now its engine has it", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const windowsFeatures = source("../../lib/platformFeatures.windows.ts");
  const macFeatures = source("../../lib/platformFeatures.ts");
  const missing = JSON.parse(source("../../../../../packages/expo-windows/src/engine/domains/forwarded.json")).missing;
  const flags = { passwordAutofillSwitch: [false, true], answersPermissionRequests: [false, true], ardiaCommand: [false, true], preloadPages: [false, true], pushMessaging: [false, true] };
  for (const [flag, [onWindows, onMac]] of Object.entries(flags)) {
    assert.match(windowsFeatures, new RegExp(`${flag}: ${onWindows}\\b`), `Windows ${flag}`);
    assert.match(macFeatures, new RegExp(`${flag}: ${onMac}\\b`), `Mac ${flag}`);
  }
  assert.ok(!missing.webView.includes("setBlockAutoplayEverywhere"));
  assert.match(windowsFeatures, /blocksAutoplay: true\b/, "Windows blocks autoplay through its engine host");
  assert.ok(missing.passwords.includes("setAutofillEnabled") && missing.passwords.includes("autofillEnabled"));
  const rowShownBy = (file, row, flag) => assert.match(source(file), new RegExp(`\\n        ${row}: \\{\\n(?:\\s+(?:title|explained|description|keywords):.*\\n)*\\s+shown: \\(\\) => PLATFORM_FEATURES\\.${flag},`), row);
  rowShownBy("./rows/profileRows.ts", "offerToSavePasswords", "passwordAutofillSwitch");
  rowShownBy("./rows/advancedRows.ts", "ardiaCommand", "ardiaCommand");
  rowShownBy("./rows/advancedRows.ts", "compactCliPill", "ardiaCommand");
  rowShownBy("./rows/profileRows.ts", "preloadPages", "preloadPages");
  assert.ok(missing.sites.includes("preloadPages") && missing.sites.includes("setPreloadPages"), "Windows has no preload pages call yet");
  assert.match(source("./panes/Profiles.tsx"), /\{PLATFORM_FEATURES\.preloadPages \? <PreloadPagesRow profileId=\{profileId\} \/> : null\}/);
  assert.match(source("../../state/site/siteControls.ts"), /offersSiteSetting = \(type: SiteSettingType\) => type !== "autoplay" \|\| PLATFORM_FEATURES\.blocksAutoplay;/);
  const sites = source("./panes/SiteSettings.tsx");
  assert.match(sites, /\{\(PLATFORM_FEATURES\.blocksAutoplay \|\| PLATFORM_FEATURES\.answersPermissionRequests \|\| PLATFORM_FEATURES\.pushMessaging\) && \(\s*<>\s*<SectionHeader title="All sites"/);
  assert.match(sites, /\{PLATFORM_FEATURES\.pushMessaging \? \(/);
  assert.match(sites, /\{PLATFORM_FEATURES\.answersPermissionRequests \? \(/);
  assert.ok(missing.permissions.includes("resolve"));
  assert.doesNotMatch(source("./rows/tabRows.ts"), /popupsOpenAsTabs: \{[^}]*shown:/, "Windows opens pop-ups as tabs itself, so the row shows there");
});
