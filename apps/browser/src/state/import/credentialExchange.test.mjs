import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const savedCodes = [];
globalThis.acTestNativeModules = {
  ArdiaVault: {
    call: async (name, profile, args) => {
      if (name !== "saveSecret") return JSON.stringify(null);
      const parsed = JSON.parse(args);
      savedCodes.push({ profile, ...parsed });
      return JSON.stringify({ saved: true });
    },
  },
};

const stub = await import("../../test-native/index.ts");
const { saveExchangedCredentials, exchangeResultLines, exchangeSummary } = await import("./credentialExchange.ts");
const logins = () => stub.passwordStores.get(stub.current.device);

const exchange = (overrides) => ({ exporter: "Passwords", source: "apple", logins: [], codes: [], passkeys: 0, noSite: 0, unsupported: 0, receiveMs: 3, parseMs: 1, ...overrides });

test("passwords and codes land in the profile, duplicates once, sites without a website skipped", async () => {
  stub.passwordStores.set(stub.current.device, new Map());
  savedCodes.length = 0;
  const result = await saveExchangedCredentials(
    "",
    exchange({
      logins: [
        { url: "https://login.example.test/signin", username: "alice", password: "one" },
        { url: "https://LOGIN.example.test/other", username: "alice", password: "one" },
        { url: "https://b.example.test/", username: "bob", password: "two" },
        { url: "", username: "carol", password: "three" },
      ],
      codes: [{ url: "https://login.example.test/signin", username: "alice", otpAuth: "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP" }],
      passkeys: 2,
      noSite: 1,
      unsupported: 3,
    }),
    null,
  );
  assert.deepEqual(
    [...logins().values()].map((l) => [l.url, l.username]).sort(),
    [
      ["https://b.example.test", "bob"],
      ["https://login.example.test", "alice"],
    ],
  );
  assert.equal(savedCodes.length, 1);
  assert.equal(savedCodes[0].origin, "https://login.example.test");
  assert.equal(savedCodes[0].username, "alice");
  assert.match(savedCodes[0].uri, /^otpauth:\/\/totp\//);
  assert.deepEqual(result, { exporter: "Passwords", saved: 2, existing: 0, failed: 0, codes: 1, codesFailed: 0, passkeys: 2, skipped: 5 });
  assert.deepEqual(exchangeResultLines(result), [
    "1 verification code saved with its login.",
    "5 items skipped: no website, or not a password or code.",
    "2 passkeys stayed in Passwords: Ardia can't store imported passkeys yet.",
  ]);
  assert.equal(exchangeSummary(result), "Imported 2 passwords and 1 verification code from Passwords. 5 skipped.");
});

test("a login already saved with another password counts as already saved, not as a failure", async () => {
  stub.passwordStores.set(stub.current.device, new Map());
  await saveExchangedCredentials("", exchange({ logins: [{ url: "https://a.example.test", username: "u", password: "old" }] }), null);
  const again = await saveExchangedCredentials("", exchange({ logins: [{ url: "https://a.example.test", username: "u", password: "new" }] }), null);
  assert.equal(again.saved, 0);
  assert.equal(again.existing, 1);
  assert.equal(again.failed, 0);
  assert.deepEqual(exchangeResultLines(again), ["1 password was already saved."]);
});

test("1,000 logins save in parallel without the JS side costing more than a few milliseconds a row", async () => {
  stub.passwordStores.set(stub.current.device, new Map());
  const rows = Array.from({ length: 1000 }, (_, n) => ({ url: `https://site${n}.example.test/login`, username: `user${n}`, password: `pw-${n}` }));
  const started = performance.now();
  const result = await saveExchangedCredentials("", exchange({ logins: rows }), null);
  const ms = performance.now() - started;
  assert.equal(result.saved, 1000);
  assert.equal(logins().size, 1000);
  assert.equal(exchangeSummary(result), "Imported 1,000 passwords from Passwords.");
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("the engine's batch save takes every row in one call per 500 when it exists", async () => {
  const batches = [];
  globalThis.acTestNativeModules.ArdiaPasswords = {
    saveMany: async (profile, json) => {
      const rows = JSON.parse(json);
      batches.push(rows.length);
      return JSON.stringify({ added: rows.length - 1, existing: 1, invalid: 0, results: [] });
    },
  };
  try {
    const rows = Array.from({ length: 1200 }, (_, n) => ({ url: `https://batch${n}.example.test`, username: "u", password: "p" }));
    const result = await saveExchangedCredentials("", exchange({ logins: rows }), null);
    assert.deepEqual(batches, [500, 500, 200]);
    assert.equal(result.saved, 1197);
    assert.equal(result.existing, 3);
    assert.deepEqual(exchangeResultLines({ ...result, codes: 1200, failed: 1000, codesFailed: 500, skipped: 2500, passkeys: 1001 }), [
      "1,200 verification codes saved with their logins.",
      "3 passwords were already saved.",
      "1,500 couldn't be saved.",
      "2,500 items skipped: no website, or not a password or code.",
      "1,001 passkeys stayed in Passwords: Ardia can't store imported passkeys yet.",
    ]);
    assert.equal(exchangeSummary({ ...result, existing: 1000, failed: 0, skipped: 500 }), "Imported 1,197 passwords from Passwords. 1,500 skipped.");
  } finally {
    delete globalThis.acTestNativeModules.ArdiaPasswords;
  }
});

test("an engine without the batch call falls back to one save each instead of failing every row", async () => {
  stub.passwordStores.set(stub.current.device, new Map());
  globalThis.acTestNativeModules.ArdiaPasswords = {
    saveMany: async () => {
      throw new Error("no such call: ac_passwords_add_many");
    },
  };
  try {
    const rows = Array.from({ length: 30 }, (_, n) => ({ url: `https://fallback${n}.example.test`, username: "u", password: "p" }));
    const result = await saveExchangedCredentials("", exchange({ logins: rows }), null);
    assert.equal(result.saved, 30);
    assert.equal(result.failed, 0);
    assert.equal(logins().size, 30);
  } finally {
    delete globalThis.acTestNativeModules.ArdiaPasswords;
  }
});
