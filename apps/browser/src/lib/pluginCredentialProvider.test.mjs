import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const { readManifest, contributionsOf } = await import("./pluginManifest.ts");
const { appProblems } = await import("../state/plugins/appChecks.ts");
const { consentLines } = await import("../state/plugins/consent.ts");
const { useBrowser } = await import("../state/browser/store.ts");

const fixtures = new URL("../../../../tests/fixtures/plugins/", import.meta.url);
const shared = JSON.parse(readFileSync(new URL("credential-manifests.json", fixtures), "utf8"));
const official = Object.fromEntries(readdirSync(new URL("credential-providers/", fixtures)).map((file) => [file.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(`credential-providers/${file}`, fixtures), "utf8"))]));
const read = (manifest) => readManifest(JSON.stringify(manifest));
const OFFICIAL_FOLDER = `official-${"a".repeat(64)}`;
const settings = () => useBrowser.getState().settings;

test("the app reads the shared credential-provider fixture with the SDK's exact messages", () => {
  for (const { why, manifest } of shared.accepted) {
    const { manifest: m, problems } = read(manifest);
    assert.deepEqual(problems, [], why);
    assert.ok(m.contributes.credentialProvider, why);
    assert.equal(m.main.memoryMB, 1024, why);
    assert.ok(contributionsOf(m).includes("credentialProvider"), why);
  }
  for (const { why, manifest, problems } of shared.rejected) assert.deepEqual(read(manifest).problems, problems.map((p) => `plugin.json: ${p}`), why);
});

test("a credential provider loads only from an official copy, and its name is kept for it", () => {
  const { manifest } = read(official.bitwarden);
  assert.deepEqual(appProblems(manifest, settings(), "99.0.0", OFFICIAL_FOLDER), []);
  assert.deepEqual(appProblems(manifest, settings(), "99.0.0", ""), [
    "plugin.json: official is only for Ardia's official plugins",
    "plugin.json: contributes.credentialProvider: Ardia runs password managers only from its official plugins",
  ]);
  const reserved = { claims: {}, failClosed: false, providers: { bitwarden: "Bitwarden" } };
  const impostor = read({ manifest: 2, name: "bitwarden", title: "Not Bitwarden", version: "1.0.0" }).manifest;
  assert.deepEqual(appProblems(impostor, settings(), "99.0.0", "", reserved), ["plugin.json: name: bitwarden is kept for Ardia's official Bitwarden plugin"]);
  assert.deepEqual(appProblems(impostor, settings(), "99.0.0", OFFICIAL_FOLDER, reserved), []);
});

test("the consent sheet names what each official provider reads, runs and opens", () => {
  const lines = (name) => consentLines(read(official[name]).manifest).map((l) => `${l.icon} ${l.text}`);
  assert.deepEqual(lines("bitwarden").slice(1, 6), [
    "key.fill Reads and saves logins and passkeys in Bitwarden",
    "terminal.fill Runs bw on your Mac, outside Ardia's sandbox, only for: status, login, unlock, lock, logout, config server, sync, list items, get, create item and edit item",
    "lock.shield What you type in its secret fields goes to bw, never to the plugin",
    "globe Gets a site's address when you save a login or passkey for it",
    "touchid Can keep Bitwarden unlocked with Touch ID, holding its session in your Keychain",
  ]);
  assert.ok(lines("1password").includes("checkmark.shield Asks 1Password to approve Ardia when you sign in"));
  assert.ok(lines("protonpass").includes("safari Opens proton.me in a new tab when you sign in"));
  for (const name of Object.keys(official)) for (const line of lines(name)) assert.ok(!line.endsWith(".") && !line.includes("\u2014"), line);
});
