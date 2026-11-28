import assert from "node:assert/strict";
import { test } from "node:test";

await import("../../test-native/ardiacore.ts");
const { passwordPromptCopy, passwordPromptAction } = await import("./prompts.ts");

const prompt = (state, target) => ({ state, origin: "https://save.localhost", username: "ada@save.test", passwordLength: 8, federation: "", usernames: ["ada@save.test"], ...(target ? { target } : {}) });

test("Ardia's own Apple Passwords prompt asks to connect and never promises a save, since Apple Passwords asks the user itself", () => {
  for (const state of ["save", "update"]) {
    const copy = passwordPromptCopy(prompt(state, "applePasswords"));
    assert.equal(copy.title, "Connect Apple Passwords?");
    assert.match(copy.message, /save\.localhost/);
    assert.doesNotMatch(`${copy.title} ${copy.message}`, /will be (auto-)?filled|\bsaved\b/i, "nothing says the login will be saved or filled");
    assert.equal(passwordPromptAction(prompt(state, "applePasswords")), "Connect");
  }
  assert.match(passwordPromptCopy(prompt("save", "applePasswords")).message, /ask to save/);
  assert.match(passwordPromptCopy(prompt("update", "applePasswords")).message, /ask to update/);
});

test("the not-saved notice and Ardia's own store keep their copy and buttons", () => {
  assert.equal(passwordPromptCopy(prompt("notSaved", "applePasswords")).title, "Not saved to Apple Passwords");
  assert.equal(passwordPromptCopy(prompt("save")).title, "Save password for save.localhost?");
  assert.equal(passwordPromptAction(prompt("save")), "Save");
  assert.equal(passwordPromptAction(prompt("update")), "Update");
});
