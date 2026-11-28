import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIXTURES, fakeHelper } from "../scripts/apple-passwords/fake.mjs";
import { runSwiftTests } from "./swift-testing.mjs";

const CLIENT = ["../ios/ApplePasswordsClient.swift", "../ios/ApplePasswordsPipe.swift", "../ios/ApplePasswordsSRP.swift", "../ios/ApplePasswordsSRP+Sealing.swift", "../ios/ApplePasswordsMatch.swift", "./apple-passwords-client-stubs.swift"];

test("the Apple Passwords client ends a session whose helper died before it starts another", { skip: process.platform !== "darwin", timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeHelper(join(dir, "fake"));
  runSwiftTests(t, "apple-passwords-client-test", [...CLIENT, "./apple-passwords-client.test.swift"], {
    env: { ARDIA_FAKE_MANIFEST: fake.manifest, ARDIA_FAKE_DIR: fake.dir, ARDIA_FAKE_CODE: FIXTURES.code },
    flags: ["-D", "DEBUG"],
  });
});

test("the Apple Passwords client lets go of a dead helper's pipe once its requests were answered", { skip: process.platform !== "darwin", timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-client-deadlines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeHelper(join(dir, "fake"));
  runSwiftTests(t, "apple-passwords-deadlines-test", [...CLIENT, "./apple-passwords-deadlines.test.swift"], {
    env: { ARDIA_FAKE_MANIFEST: fake.manifest, ARDIA_FAKE_DIR: fake.dir, ARDIA_FAKE_CODE: FIXTURES.code },
    flags: ["-D", "DEBUG"],
  });
});

test("the Apple Passwords client sends a save as Apple's extension does and claims nothing from its reply", { skip: process.platform !== "darwin", timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-client-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeHelper(join(dir, "fake"));
  runSwiftTests(t, "apple-passwords-save-test", [...CLIENT, "./apple-passwords-save.test.swift"], {
    env: { ARDIA_FAKE_MANIFEST: fake.manifest, ARDIA_FAKE_DIR: fake.dir, ARDIA_FAKE_CODE: FIXTURES.code },
    flags: ["-D", "DEBUG"],
  });
});
