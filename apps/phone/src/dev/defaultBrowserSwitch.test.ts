import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const project = read("../../ios/Ardia.xcodeproj/project.pbxproj");
const info = read("../../ios/Ardia/Info.plist");
const entitlements = (name: string) => read(`../../ios/Config/${name}`);
const WEB_BROWSER = "com.apple.developer.web-browser";

test("the iPhone app ships with the default browser off until Apple grants the web-browser entitlement", () => {
  const switches = [...project.matchAll(/ARDIA_DEFAULT_BROWSER = (\w+);/g)].map((match) => match[1]);
  assert.ok(switches.length >= 2, "Debug and Release both set ARDIA_DEFAULT_BROWSER");
  assert.deepEqual([...new Set(switches)], ["NO"], "every configuration builds with ARDIA_DEFAULT_BROWSER = NO");
  assert.equal(entitlements("Ardia.entitlements").includes(WEB_BROWSER), false, "the entitlements used today never claim the web-browser entitlement");
});

test("one build setting turns on the entitlement and the Info.plist key together, so the app is never half on", () => {
  assert.match(project, /ARDIA_ENTITLEMENTS_NO = Config\/Ardia\.entitlements;/);
  assert.match(project, /ARDIA_ENTITLEMENTS_YES = "Config\/Ardia-DefaultBrowser\.entitlements";/);
  const signing = [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = (.+);/g)].map((match) => match[1]!.replaceAll('"', ""));
  assert.ok(signing.includes("$(ARDIA_ENTITLEMENTS_$(ARDIA_DEFAULT_BROWSER))"), "the app target picks its entitlements from ARDIA_DEFAULT_BROWSER");
  assert.match(info, /<key>ArdiaDefaultBrowser<\/key>\s*<string>\$\(ARDIA_DEFAULT_BROWSER\)<\/string>/, "DefaultBrowserStatus.isOffered reads the same setting");
  const granted = entitlements("Ardia-DefaultBrowser.entitlements");
  assert.match(granted, new RegExp(`<key>${WEB_BROWSER}</key>\\s*<true/>`));
  assert.equal(granted.replace(new RegExp(`\\s*<key>${WEB_BROWSER}</key>\\s*<true/>`), ""), entitlements("Ardia.entitlements"), "the two files differ only by the web-browser entitlement");
});

test("the app already declares http and https, which iOS requires of a default browser", () => {
  assert.match(info, /<array>\s*<string>http<\/string>\s*<string>https<\/string>\s*<\/array>/);
});
