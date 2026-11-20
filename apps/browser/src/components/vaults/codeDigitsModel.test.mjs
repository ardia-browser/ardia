import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { advanceRoll, codeCells, restingRoll, rolledDigits, spokenCode } = await import("./codeDigitsModel.ts");
const vaultCodes = await import("../../state/vaults/codes.ts");
const { useVaultMenus } = await import("../../state/vaults/menu.ts");
const { useVaults } = await import("../../state/vaults/store.ts");
const { useStandaloneCodes } = await import("../../state/vaults/standaloneCodes.ts");
const { readArdiaCode } = await import("../../state/vaults/ardiaCodes.ts");

const shape = (code) => codeCells(code).map((c) => (c.kind === "space" ? " " : c.char)).join("");
const at = (code, expiresAt, owner = "ardia/a") => ({ owner, code, expiresAt, period: 30 });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("six and eight digit codes split into two equal groups with one fixed space; other lengths stay whole", () => {
  assert.equal(shape("682803"), "682 803");
  assert.equal(shape("12345678"), "1234 5678");
  assert.equal(shape("1234567"), "1234567");
  assert.equal(shape("12345"), "12345");
  assert.deepEqual(
    codeCells("682803").map((c) => c.kind),
    ["digit", "digit", "digit", "space", "digit", "digit", "digit"],
  );
  assert.deepEqual(
    codeCells("682803").filter((c) => c.kind === "digit").map((c) => c.at),
    [0, 1, 2, 3, 4, 5],
    "digit positions skip the space, so a digit keeps its slot across codes",
  );
});

test("only the digits that differ roll at the next period", () => {
  assert.deepEqual(rolledDigits(at("682803", 30_000), at("682913", 60_000)), [false, false, false, true, true, false]);
  assert.deepEqual(rolledDigits(at("000000", 30_000), at("999999", 60_000)), [true, true, true, true, true, true]);
  assert.equal(rolledDigits(at("682803", 30_000), at("682803", 60_000)), null, "the same code twice doesn't move");
});

test("VoiceOver hears the whole code once, digit by digit", () => {
  assert.equal(spokenCode("682803"), "Code 6 8 2 8 0 3");
});

test("the first code shown, a code after loading, and a different item's code all appear without rolling", () => {
  const first = restingRoll(at("682803", 30_000));
  assert.equal(first.roll, null);
  assert.equal(advanceRoll(restingRoll(null), at("682803", 30_000)).roll, null, "loading dots to digits");
  const switched = advanceRoll(first, at("111222", 60_000, "ardia/b"));
  assert.equal(switched.roll, null, "another item, even one period on");
  assert.equal(switched.shown.owner, "ardia/b");
});

test("coming back after several periods shows the current code without replaying the missed ones", () => {
  const shown = restingRoll(at("682803", 30_000));
  assert.equal(advanceRoll(shown, at("444555", 120_000)).roll, null);
  assert.equal(advanceRoll(shown, at("444555", 30_000)).roll, null, "a new secret in the same period isn't a rollover");
});

test("a rollover rolls once, a fresh read of the same code doesn't cut it short, and the next one starts a new turn", () => {
  const rolled = advanceRoll(restingRoll(at("682803", 30_000)), at("682913", 60_000));
  assert.deepEqual(rolled.roll, { changed: [false, false, false, true, true, false], turn: 1 });
  const reread = advanceRoll(rolled, at("682913", 60_004));
  assert.equal(reread.roll, rolled.roll, "the native read lands mid-roll with a slightly different expiry");
  assert.equal(advanceRoll(reread, at("682913", 60_004)), reread, "nothing changed, same state, no render");
  const again = advanceRoll(reread, at("103913", 90_004));
  assert.deepEqual(again.roll, { changed: [true, true, true, false, false, false], turn: 2 });
});

test("a code's rollover touches only its own entry: the menu, its rows and the Settings lists don't hear it", async () => {
  const now = Date.now();
  const other = { code: "999999", period: 30, expiresAt: now + 20_000 };
  vaultCodes.useVaultCodes.setState({ "ardia/a": { code: "111111", period: 30, expiresAt: now - 1, next: "222222" }, "ardia/b": other }, true);
  const heard = { menus: 0, vaults: 0, standalone: 0, otherRow: 0 };
  const stops = [
    useVaultMenus.subscribe(() => (heard.menus += 1)),
    useVaults.subscribe(() => (heard.vaults += 1)),
    useStandaloneCodes.subscribe(() => (heard.standalone += 1)),
    vaultCodes.useVaultCodes.subscribe((s, was) => s["ardia/b"] !== was["ardia/b"] && (heard.otherRow += 1)),
  ];
  await vaultCodes.loadVaultCode({ provider: "ardia", id: "a" });
  await readArdiaCode({ provider: "ardia", id: "c" });
  await settle();
  for (const stop of stops) stop();
  assert.equal(vaultCodes.useVaultCodes.getState()["ardia/a"].code !== "111111", true, "the ticking row got its new code");
  assert.equal(vaultCodes.useVaultCodes.getState()["ardia/b"], other);
  assert.deepEqual(heard, { menus: 0, vaults: 0, standalone: 0, otherRow: 0 });
});
