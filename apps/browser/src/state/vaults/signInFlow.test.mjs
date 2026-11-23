import assert from "node:assert/strict";
import { test } from "node:test";
import { canSubmit, errorAfter, needsOf, requestFor, signInMessage } from "./signInFlow.ts";
import { methodsOf, unlockFieldOf } from "./providerModel.ts";

const bitwarden = {
  id: "bitwarden",
  name: "Bitwarden",
  title: "Bitwarden",
  state: "signedOut",
  signIn: {
    methods: [
      { id: "password", title: "Email and Password", kind: "credentials", fields: [{ id: "email", title: "Email", kind: "email", prefill: "account" }, { id: "masterPassword", title: "Master Password", kind: "secret" }] },
      { id: "apiKey", title: "API Key", kind: "credentials", fields: [{ id: "clientId", title: "Client ID", kind: "secret", masked: false }, { id: "clientSecret", title: "Client Secret", kind: "secret" }] },
      { id: "browser", title: "Sign In with Browser", kind: "browserApproval", fields: [{ id: "extraPassword", title: "Extra Password", kind: "secret", optional: true }] },
    ],
    unlockField: "masterPassword",
  },
};
const failed = (error, extra = {}) => ({ ok: false, state: { ...bitwarden, ...extra.state }, error, ...extra });

test("the declared methods become the sheet's: unmasked secrets stay native but show their text", () => {
  const [password, apiKey, browser] = methodsOf(bitwarden);
  assert.equal(password.kind, "credentials");
  assert.deepEqual(password.fields.map((f) => [f.id, f.type, f.prefill]), [["email", "email", true], ["masterPassword", "secret", false]]);
  assert.equal(apiKey.fields[0].revealed, true);
  assert.equal(apiKey.fields[1].revealed, false);
  assert.equal(browser.kind, "browserApproval");
  assert.equal(unlockFieldOf(bitwarden).title, "Master Password");
  assert.deepEqual(methodsOf({ ...bitwarden, signIn: undefined, setup: { kind: "desktopIntegration", appURL: "onepassword://" } }).map((m) => [m.kind, m.appURL]), [["desktopApproval", "onepassword://"]]);
});

test("Sign In waits for every required field; secrets travel only as entry tokens and empty optional fields are left out", () => {
  const [password, , browser] = methodsOf(bitwarden);
  const typed = { values: { email: "  sam@example.com " }, secretLengths: { masterPassword: 0 } };
  assert.equal(canSubmit(password, typed, true), false);
  const ready = { ...typed, secretLengths: { masterPassword: 9 } };
  assert.equal(canSubmit(password, ready, false), false);
  assert.equal(canSubmit(password, ready, true), true);
  assert.deepEqual(requestFor(password, ready, { masterPassword: "entry-7" }, "eu"), { method: "password", server: "eu", values: { email: "sam@example.com" }, secrets: { masterPassword: "entry-7" } });
  assert.equal(canSubmit(browser, { values: {}, secretLengths: {} }, true), true);
  assert.deepEqual(requestFor(browser, { values: {}, secretLengths: {} }, {}, undefined), { method: "browser", values: {}, secrets: {} });
});

test("an unanswered call reads as the manager not responding, a native problem reads as itself, a cancel shows nothing", () => {
  assert.equal(signInMessage(failed("failed"), "Proton Pass"), "Proton Pass didn't respond. Try again.");
  assert.equal(signInMessage({ ok: false }, "Bitwarden"), "Bitwarden didn't respond. Try again.");
  assert.equal(signInMessage(failed("The email or master password isn't right."), "Bitwarden"), "The email or master password isn't right.");
  assert.equal(signInMessage(failed(undefined, { state: { problem: { code: "offline", message: "You're offline." } } }), "Bitwarden"), "You're offline.");
  assert.equal(signInMessage(failed("cancelled"), "Bitwarden"), "");
  assert.equal(signInMessage({ ok: true, state: bitwarden }, "Bitwarden"), "");
});

test("a follow-up comes from the provider state, or from an older broker's needs and methods", () => {
  const code = { kind: "code", methods: [{ id: "0", title: "Authenticator App" }] };
  assert.deepEqual(needsOf(failed(undefined, { state: { needs: code } })), code);
  assert.deepEqual(needsOf(failed(undefined, { needs: "code", methods: [{ id: "1", name: "Email" }] })), { kind: "code", methods: [{ id: "1", title: "Email" }] });
  assert.equal(needsOf({ ok: true, state: { ...bitwarden, needs: code } }), null);
  assert.equal(needsOf(null), null);
});

test("asking for a code isn't an error, a wrong code is, and waiting for the browser never shows one", () => {
  const code = { kind: "code" };
  assert.equal(errorAfter(failed(undefined, { state: { needs: code } }), "Bitwarden", null), "");
  assert.equal(errorAfter(failed("That code isn't right.", { state: { needs: code } }), "Bitwarden", code), "That code isn't right.");
  assert.equal(errorAfter(failed(undefined, { state: { needs: { kind: "password" } } }), "Bitwarden", code), "");
  assert.equal(errorAfter(failed("Opened", { state: { needs: { kind: "approval" } } }), "Bitwarden", null), "");
  assert.equal(errorAfter(failed("cancelled"), "Bitwarden", code), "");
});

test("an expired typed unlock is counted next to the failure", async () => {
  const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
  setConsentPeriod(true, "expired-unlock");
  const { noteVaultSignIn, takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
  takeVaultCounts();
  noteVaultSignIn(false, true, true);
  noteVaultSignIn(false, true);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_unlock_entries_expired, 1);
  assert.equal(counts.vault_unlock_failures, 2);
});
