import { readFileSync } from "node:fs";
import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

const swift = readFileSync(new URL("../ios/WebKitAutofillScript.swift", import.meta.url), "utf8");
const script = swift.slice(swift.indexOf('static let source = #"""\n') + 25, swift.indexOf('\n"""#'));

test("a WebKit card or address fill lands byte for byte and never puts the values in script source", (t) => {
  runSwiftTests(t, "webkit-autofill-fill-test", ["../ios/WebKitAutofillFill.swift", "./webkit-autofill-fill.test.swift"], {
    env: { ARDIA_AUTOFILL_SCRIPT: script },
  });
});
