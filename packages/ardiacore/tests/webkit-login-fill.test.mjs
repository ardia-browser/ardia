import { readFileSync } from "node:fs";
import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

const swift = readFileSync(new URL("../ios/WebKitLogins.swift", import.meta.url), "utf8");
const script = swift.slice(swift.indexOf('static let script = #"""\n') + 25, swift.indexOf('\n"""#'));

test("a WebKit login fill lands byte for byte and never puts the login in script source", (t) => {
  runSwiftTests(t, "webkit-login-fill-test", ["../ios/WebKitLoginFill.swift", "./webkit-login-fill.test.swift"], {
    env: { ARDIA_LOGINS_SCRIPT: script },
  });
});
