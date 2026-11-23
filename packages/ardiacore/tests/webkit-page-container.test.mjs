import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("a WebKit page fills its scaled tab, follows WebKit's fullscreen window and shares the tab with a docked inspector", (t) => {
  runSwiftTests(t, "page-container-test", ["../ios/WebKitPageContainer.swift", "./webkit-page-container.test.swift"]);
});
