import assert from "node:assert/strict";
import { test } from "node:test";
import { canSubmitCode, chooseCodeMethod, codeError, codePrompt, codeStepAfter, codeSubmitTitle, placeSignInError, protonFailure } from "./signInFlow.ts";

const state = { id: "bitwarden", name: "Bitwarden", state: "signedOut" };
const failed = (error, extra = {}) => ({ ok: false, state, error, ...extra });
const methods = [
  { id: "0", name: "Authenticator app" },
  { id: "1", name: "Email" },
  { id: "3", name: "YubiKey OTP" },
];

test("a wrong master password sits under the password field, a bad server under the server, a network failure under the form", () => {
  assert.deepEqual(placeSignInError(failed("The email or master password isn't right."), "Bitwarden", "login"), { field: "password", text: "The email or master password isn't right." });
  assert.deepEqual(placeSignInError(failed("Enter the server as an https address."), "Bitwarden", "login").field, "server");
  assert.deepEqual(placeSignInError(failed("Ardia couldn't reach the server, so check the address and your connection."), "Bitwarden", "login").field, "server");
  assert.deepEqual(placeSignInError(failed("You're offline, so connect to the internet and try again."), "Bitwarden", "login"), { field: null, text: "You're offline, so connect to the internet and try again." });
});

test("an unanswered call reads as the manager not responding, never as a raw code", () => {
  assert.equal(placeSignInError(failed("failed"), "Proton Pass", "token").text, "Proton Pass didn't respond. Try again.");
  assert.equal(placeSignInError({ ok: false, state }, "Bitwarden", "login").text, "Bitwarden didn't respond. Try again.");
});

test("a cancelled sign-in shows no error anywhere", () => {
  for (const stage of ["login", "apiKey", "code", "unlock", "token", "approval"]) assert.deepEqual(placeSignInError(failed("cancelled"), "Bitwarden", stage), { field: null, text: "" });
  assert.deepEqual(codeError(failed("cancelled", { needs: "code" }), "Bitwarden", { methods, method: "0", emailSent: false }), { field: null, text: "" });
});

test("API key, token and unlock errors land on the field that caused them", () => {
  assert.equal(placeSignInError(failed("Bitwarden didn't accept that API key."), "Bitwarden", "apiKey").field, "clientSecret");
  assert.equal(placeSignInError(failed("Organization keys can't sign in, so use your personal API key."), "Bitwarden", "apiKey").field, "clientId");
  assert.equal(placeSignInError(failed("Bitwarden wants to verify this Mac, so sign in with your API key instead."), "Bitwarden", "login").field, null);
  assert.equal(placeSignInError(failed("Proton didn't accept that access token."), "Proton Pass", "token").field, "token");
  assert.equal(placeSignInError(failed("That master password isn't right.", { needs: "password" }), "Bitwarden", "unlock").field, "password");
  assert.deepEqual(placeSignInError({ ok: true, state }, "Bitwarden", "login"), { field: null, text: "" });
});

test("the first two-step answer picks the first method and asks nothing yet", () => {
  const result = failed("Choose how to get your two-step login code.", { needs: "code", methods });
  const step = codeStepAfter(result, null);
  assert.deepEqual(step, { methods, method: "0", emailSent: false });
  assert.deepEqual(codeError(result, "Bitwarden", null), { field: null, text: "" });
  assert.equal(codeSubmitTitle(step), "Continue");
  assert.equal(canSubmitCode(step, "  "), false);
  assert.equal(canSubmitCode(step, "123456"), true);
});

test("choosing Email sends the code first, then asks for it, and a wrong code shows under the code field", () => {
  const first = codeStepAfter(failed("x", { needs: "code", methods }), null);
  const email = chooseCodeMethod(first, "1");
  assert.equal(codeSubmitTitle(email), "Send Code");
  assert.equal(canSubmitCode(email, ""), true);
  assert.equal(codePrompt(email), "Bitwarden emails you a code.");
  const sentResult = failed("Enter the code Bitwarden emailed you.", { needs: "code" });
  assert.deepEqual(codeError(sentResult, "Bitwarden", email), { field: null, text: "" });
  const sent = codeStepAfter(sentResult, email);
  assert.equal(sent.emailSent, true);
  assert.equal(codeSubmitTitle(sent), "Continue");
  assert.equal(canSubmitCode(sent, ""), false);
  assert.equal(codePrompt(sent), "Enter the code Bitwarden emailed you.");
  const wrong = failed("That code didn't work. Try a new one.", { needs: "code" });
  assert.deepEqual(codeError(wrong, "Bitwarden", sent), { field: "code", text: "That code didn't work. Try a new one." });
  assert.equal(codeStepAfter(wrong, sent).emailSent, true);
});

test("switching away from Email and back asks to send again", () => {
  const first = codeStepAfter(failed("x", { needs: "code", methods }), null);
  const sent = { ...chooseCodeMethod(first, "1"), emailSent: true };
  assert.equal(chooseCodeMethod(chooseCodeMethod(sent, "0"), "1").emailSent, false);
  assert.equal(chooseCodeMethod(sent, "1"), sent);
});

test("a failure that isn't about the code keeps the code step and shows the error", () => {
  const step = codeStepAfter(failed("x", { needs: "code", methods }), null);
  const newDevice = failed("Bitwarden wants to verify this Mac, so sign in with your API key instead.");
  assert.equal(codeStepAfter(newDevice, step), step);
  assert.deepEqual(codeError(newDevice, "Bitwarden", step), { field: null, text: "Bitwarden wants to verify this Mac, so sign in with your API key instead." });
  assert.equal(codeStepAfter({ ok: true, state }, step), null);
});

test("Proton's in-progress note is not a failure, its sign-in errors are", () => {
  assert.equal(protonFailure("Finish signing in to Proton in the tab Ardia opened."), "");
  assert.equal(protonFailure(null), "");
  assert.equal(protonFailure("Proton Pass didn't start signing in. Try again."), "Proton Pass didn't start signing in. Try again.");
});

test("an unlock whose typed entry expired asks for the master password again in the password field", async () => {
  const { placeSignInError } = await import("./signInFlow.ts");
  const result = { ok: false, needs: "password", entryExpired: true, error: "Type your Bitwarden master password again." };
  assert.deepEqual(placeSignInError(result, "Bitwarden", "unlock"), { field: "password", text: "Type your Bitwarden master password again." });
});

test("an expired typed unlock is counted next to the failure", async () => {
  const { noteVaultSignIn, takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
  takeVaultCounts();
  noteVaultSignIn(false, true, true);
  noteVaultSignIn(false, true);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_unlock_entries_expired, 1);
  assert.equal(counts.vault_unlock_failures, 2);
});
