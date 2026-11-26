import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("Apple Passwords logins match the page's registrable site, its scheme and its frame", (t) => {
  runSwiftTests(t, "apple-passwords-match-test", ["../ios/ApplePasswordsMatch.swift", "./apple-passwords-match.test.swift"]);
});
