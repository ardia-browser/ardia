import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("page dialogs wait their turn, answer once, stay a sane size, and download names stay honest (Swift Testing)", (t) => {
  runSwiftTests(t, "page-dialogs-test", ["../ios/WebKitPageDialogs.swift", "../ios/WebKitDownloadNames.swift", "./webkit-page-dialogs.test.swift"]);
});

test("certificate exceptions and HSTS follow Chromium's rules (Swift Testing)", (t) => {
  runSwiftTests(t, "certificate-policy-test", ["../ios/WebKitCertificatePolicy.swift", "./webkit-certificate-policy.test.swift"]);
});

test("a WebKit page's file panel is logged, not shown, in background mode", () => {
  const source = readFileSync(new URL("../ios/WebKitTab+UIDelegate.swift", import.meta.url), "utf8");
  const panel = source.slice(source.indexOf("runOpenPanelWith"), source.indexOf("NSOpenPanel()"));
  assert.match(panel, /if LaunchConfig\.shared\.background \{\n\s+NSLog\("\[webkit\] file panel \(background mode, not shown\)"\)\n\s+return completionHandler\(nil\)/);
});
