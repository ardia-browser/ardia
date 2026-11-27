import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("an engine reply is an error only when it opens with the error key, read without scanning its body", (t) => {
  runSwiftTests(t, "engine-reply-error-test", ["../ios/EngineReplyError.swift", "./engine-reply-error.test.swift"], { flags: ["-O"] });
});
