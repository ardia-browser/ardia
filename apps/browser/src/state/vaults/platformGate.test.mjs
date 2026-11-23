import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("password managers exist on the Mac only", async () => {
  const mac = await import("../../lib/platformFeatures.ts");
  const linux = await import("../../lib/platformFeatures.linux.ts");
  const windows = await import("../../lib/platformFeatures.windows.ts");
  assert.equal(mac.PLATFORM_FEATURES.systemPasswordManagers, true);
  assert.equal(linux.PLATFORM_FEATURES.systemPasswordManagers, false);
  assert.equal(windows.PLATFORM_FEATURES.systemPasswordManagers, false);
});

test("without password managers nothing starts, nothing opens and no profile is on the fill menu", () => {
  assert.match(source("./enabled.ts"), /export const vaultsSupported = PLATFORM_FEATURES\.systemPasswordManagers;/);
  assert.match(source("./enabled.ts"), /if \(!vaultsSupported \|\| !p\.scanned\) return false;/);
  assert.match(source("./start.ts"), /export function startVaults\(\) \{\n\s+if \(!vaultsSupported\) return;/);
  assert.match(source("./saveOffer.ts"), /export function vaultClaimsPasswordPrompt\(.*\): boolean \{\n\s+if \(!vaultsSupported\) return false;/, "Chrome's own save prompt stays where there are no password managers");
});

test("a profile's Passwords page shows the app-wide manager settings only while the profile is on Ardia", () => {
  assert.match(source("../../components/settings/panes/PasswordManagers.tsx"), /export function ForAllProfilesSection\b/);
  const page = source("../../components/settings/panes/ProfilePasswords.tsx");
  const flag = /const (\w+) = vaultsSupported && \w+ === "ardia";/.exec(page)?.[1];
  assert.ok(flag, "the page decides from the profile's own choice");
  assert.match(page, new RegExp(`\\{${flag} \\? <ForAllProfilesSection`));
});
