import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SHARED = JSON.parse(readFileSync(new URL("../../../../../packages/ardiacore/tests/fixtures/vault-touch-scopes.json", import.meta.url), "utf8"));
const { touchScope } = await import("./touchScopes.ts");
const { touchScopeOfAutofill } = await import("../autofill/fieldMenu.ts");

const built = ({ kind, parts }) => {
  if (kind === "fill") return touchScope.fill(parts.provider, parts.item, parts.origin, parts.tab);
  if (kind === "unlock") return touchScope.unlock(parts.provider);
  if (kind === "passkey") return touchScope.passkey(parts.request, parts.credential);
  if (kind === "card") return touchScope.card(parts.card, parts.tab);
  return undefined;
};

test("the shared table covers every kind of Touch ID grant", () => {
  assert.deepEqual([...new Set(SHARED.scopes.map((row) => row.kind))].sort(), ["card", "fill", "passkey", "unlock"]);
});

for (const row of SHARED.scopes) {
  test(`a ${row.kind} grant is spelled as the native side takes it (${JSON.stringify(row.scope)})`, () => {
    assert.equal(built(row), row.scope);
  });
}

test("the card menu asks for the card scope the native fill takes", () => {
  const card = SHARED.scopes.find((row) => row.kind === "card");
  assert.equal(touchScopeOfAutofill(card.parts.tab, { kind: "card", card: { id: card.parts.card } }), card.scope);
  assert.equal(touchScopeOfAutofill(card.parts.tab, undefined), "", "no card row, no grant");
});
