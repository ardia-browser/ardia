import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

const hostile = readFileSync(new URL("../../../scripts/security/hostile-inputs.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const logins = readFileSync(new URL("../ios/WebKitLogins.swift", import.meta.url), "utf8");

test("B1 and B2: hostile WebKit loginField and loginSubmit messages, posted through a real WKWebView, are refused or bounded, and only the frame's own origin is used", (t) => {
  runSwiftTests(t, "webkit-login-report-test", ["../ios/Origins.swift", "../ios/StrongPassword.swift", "../ios/LoginListField.swift", "../ios/WebKitLoginsReport.swift", "../ios/ApplePasswordsMatch.swift", "./webkit-login-report.test.swift"], {
    env: { ARDIA_HOSTILE_INPUTS: hostile },
  });
});

test("B2: WebKit Login list native reads the page's claimed origin only to check it against the frame's", () => {
  const reads = logins.match(/data\["origin"\]/g) ?? [];
  const checked = logins.match(/WebKitLoginsReport\.frameOrigin\((origin|frame\.securityOrigin), claimed: data\["origin"\]\)/g) ?? [];
  assert.ok(reads.length > 0);
  assert.equal(checked.length, reads.length, "every read of the page's origin is the claim frameOrigin checks");
});
