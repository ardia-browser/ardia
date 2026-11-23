import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleForTests } from "../build.mjs";

const sdk = await bundleForTests(`
  export { vaultctl } from "./src/provider";
  export { createCredentialHarness } from "@ardia/plugin-sdk/testing";
`);
const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

const SESSION = "session-key-0123456789abcdef";
const PASSWORD = "fixture-master-pw";

function fakeVaultctl(routes) {
  return (launch) => {
    const line = launch.argv.join(" ");
    const route = routes.find(([prefix]) => line === prefix || line.startsWith(`${prefix} `));
    if (!route) return { status: 1, stderr: `no fake route for ${line}` };
    return typeof route[1] === "function" ? route[1](launch) : route[1];
  };
}

const harness = (routes, context) => sdk.createCredentialHarness({ provider: sdk.vaultctl, manifest, cli: fakeVaultctl(routes), context });

test("signing in sends the password on stdin, keeps the printed key as the session and remembers the account", async () => {
  const h = harness([["login me@example.com --password-stdin --raw", (launch) => (launch.stdin === PASSWORD ? { stdout: `${SESSION}\n` } : { status: 1, stderr: "invalid master password" })]]);
  const answer = await h.call("signIn", { method: "password", step: "start", fields: { email: "me@example.com", password: h.secret(PASSWORD) } });
  assert.deepEqual(answer, { ok: true, result: { ok: true } });
  assert.deepEqual(h.session, { key: SESSION });
  assert.equal(h.preferences.account, "me@example.com");
});

test("a wrong master password asks again on the password field", async () => {
  const h = harness([["login", { status: 1, stderr: "Invalid master password." }]]);
  const answer = await h.call("signIn", { method: "password", step: "start", fields: { email: "me@example.com", password: h.secret(PASSWORD) } });
  assert.deepEqual(answer.result, { ok: false, problem: "wrongCredentials", field: "password" });
  assert.equal(h.session, null);
});

test("listing streams items and revealing reads one field with the session", async () => {
  const items = [{ id: "a1", name: "Example", username: "me", urls: ["https://example.com"], hasTotp: true }, { name: "no id" }];
  const h = harness(
    [
      ["list --json", (launch) => (launch.env.VAULTCTL_SESSION === SESSION ? { stdout: JSON.stringify(items) } : { status: 1, stderr: "vault is locked" })],
      ["get password a1", { stdout: "hunter2-password\n" }],
    ],
    { session: { key: SESSION } },
  );
  const listed = await h.call("list", { snapshot: null, cursor: null });
  assert.deepEqual(listed.result.items, [{ id: "a1", title: "Example", username: "me", urls: ["https://example.com"], hasTotp: true }]);
  assert.deepEqual((await h.call("reveal", { id: "a1", fields: ["password"] })).result, { password: "hunter2-password" });
});

test("locking runs vaultctl lock with the session and leaves the provider locked", async () => {
  const h = harness([["lock", { stdout: "" }], ["list --json", { status: 1, stderr: "vault is locked" }]], { session: { key: SESSION } });
  await h.lock();
  assert.equal(h.launches.at(-1).argv.join(" "), "lock");
  assert.equal(h.launches.at(-1).env.VAULTCTL_SESSION, SESSION);
  assert.deepEqual((await h.call("list", { snapshot: null, cursor: null })).error, { code: "locked" });
});
