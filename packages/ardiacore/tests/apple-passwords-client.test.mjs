import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIXTURES, fakeHelper } from "../scripts/apple-passwords/fake.mjs";
import { runSwiftTests } from "./swift-testing.mjs";

test("the Apple Passwords client ends a session whose helper died before it starts another", { skip: process.platform !== "darwin", timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeHelper(join(dir, "fake"));
  runSwiftTests(t, "apple-passwords-client-test", ["../ios/ApplePasswordsClient.swift", "../ios/ApplePasswordsPipe.swift", "../ios/ApplePasswordsSRP.swift", "../ios/ApplePasswordsSRP+Sealing.swift", "../ios/ApplePasswordsMatch.swift", "./apple-passwords-client.test.swift"], {
    env: { ARDIA_FAKE_MANIFEST: fake.manifest, ARDIA_FAKE_DIR: fake.dir, ARDIA_FAKE_CODE: FIXTURES.code },
    flags: ["-D", "DEBUG"],
  });
});
