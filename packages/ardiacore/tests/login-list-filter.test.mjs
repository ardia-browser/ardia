import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("the Login list keeps the logins whose account name contains what was typed, ranked and with the match marked", (t) => {
  runSwiftTests(t, "login-list-filter-test", ["../ios/LoginListFilter.swift", "./login-list-filter.test.swift"]);
});
