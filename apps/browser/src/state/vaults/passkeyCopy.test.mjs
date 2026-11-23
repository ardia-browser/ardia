import assert from "node:assert/strict";
import { test } from "node:test";
const { saveLine, signInLine, troubleText } = await import("./passkeyCopy.ts");

test("the save line names who asks: macOS for the system route, the extension for its own", () => {
  assert.equal(saveLine("system", "1Password", "Touch ID", false), "macOS will ask where to save it. Choose 1Password there.");
  assert.equal(saveLine("extension", "Proton Pass", "Touch ID", false), "Proton Pass will ask which login or vault to save it in.");
  assert.equal(saveLine("ardia", "Ardia", "Touch ID", false), "Saves to Ardia. You'll sign in with Touch ID, no password needed.");
  assert.match(saveLine("system", "1Password", "Touch ID", true), /stays after this window closes/);
});

test("a delegated sign-in never promises Ardia's Touch ID", () => {
  assert.equal(signInLine("system", "1Password", "Touch ID"), "1Password will ask you to confirm.");
  assert.equal(signInLine("extension", "Proton Pass", "Touch ID"), "Proton Pass will ask you to confirm.");
  assert.equal(signInLine("ardia", "Ardia", "Touch ID"), "You'll confirm with Touch ID.");
  assert.equal(signInLine("ardia", "Ardia", "your login password"), "You'll confirm with your login password.");
});

test("a hand-off that came back says what happened and what to do, never sends the person to Chrome", () => {
  assert.equal(troubleText("returned", false, "Proton Pass", "github.com"), "Proton Pass didn't sign you in. It may be locked, or have no passkey for github.com. Try again, or choose another way.");
  assert.equal(troubleText("systemFailed", true, "1Password", "github.com"), "macOS couldn't save the passkey to 1Password. Try again, or save it somewhere else.");
});
