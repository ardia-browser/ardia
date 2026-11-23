import assert from "node:assert/strict";
import { test } from "node:test";
const { deleteLoginMessage } = await import("./deleteLogin.ts");

const carol = { origin: "https://example.com", username: "carol@example.test" };
const dave = { origin: "https://example.com", username: "dave@example.test" };
const elsewhere = { origin: "https://other.example", username: "dave@example.test" };

test("deleting one of several logins for a site names the account", () => {
  assert.equal(deleteLoginMessage(carol, [carol, dave]), "Ardia won't fill carol@example.test on this website anymore.");
});

test("the only login for a site doesn't need its account named", () => {
  assert.equal(deleteLoginMessage(carol, [carol, elsewhere]), "Ardia won't fill it on this website anymore.");
  assert.equal(deleteLoginMessage({ ...carol, username: "" }, [carol, { ...carol, username: "" }]), "Ardia won't fill it on this website anymore.");
});
