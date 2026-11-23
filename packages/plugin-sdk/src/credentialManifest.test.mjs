import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const { checkCredentialManifest, readCredentialContribution } = await import("./credentialManifest.ts");

const fixtures = new URL("../../../tests/fixtures/plugins/", import.meta.url);
const shared = JSON.parse(readFileSync(new URL("credential-manifests.json", fixtures), "utf8"));
const official = readdirSync(new URL("credential-providers/", fixtures)).map((file) => ({ file, manifest: JSON.parse(readFileSync(new URL(`credential-providers/${file}`, fixtures), "utf8")) }));

test("every accepted manifest in the shared fixture reads without problems", () => {
  for (const { why, manifest } of [...shared.accepted, ...official.map((o) => ({ why: o.file, manifest: o.manifest }))]) assert.deepEqual(checkCredentialManifest(manifest), [], why);
});

test("every rejected manifest in the shared fixture gives exactly its messages", () => {
  for (const { why, manifest, problems } of shared.rejected) assert.deepEqual(checkCredentialManifest(manifest), problems, why);
});

test("a parsed contribution fills the defaults the host relies on", () => {
  const minimal = {
    title: "Mini",
    signIn: { methods: [{ id: "token", title: "Token", fields: [{ id: "token", title: "Token", type: "secret" }] }] },
    cli: { name: "mini", install: { command: "brew install mini" }, verbs: { status: { argv: ["status"], output: { mode: "json" } } } },
  };
  const parsed = readCredentialContribution(minimal);
  assert.equal(parsed.symbol, "key.fill");
  assert.equal(parsed.readsOffline, true);
  assert.deepEqual(parsed.signIn.methods[0].fields[0], { id: "token", title: "Token", type: "secret", optional: false, masked: true });
  assert.deepEqual(parsed.cli.verbs.status, { argv: ["status"], slots: {}, env: [], stdin: null, timeoutMs: 30000, outputLimitBytes: 33554432, output: { mode: "json" }, signIn: false, unlocks: false, outlivesCall: false, hints: {} });
  assert.throws(() => readCredentialContribution({ ...minimal, title: "" }), /title must be text of 1 to 40 characters/);
});
