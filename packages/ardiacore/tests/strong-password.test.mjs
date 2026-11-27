import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("Ardia's strong password is long, grouped, free of look-alike characters and fits the field's maxlength and pattern", (t) => {
  runSwiftTests(t, "strong-password-test", ["../ios/StrongPassword.swift", "./strong-password.test.swift"]);
});
