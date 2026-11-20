import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const menu = await import("./fieldMenu.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });
setConsentPeriod(true, "fieldMenu-test");

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setTimeout(r, 20));
const rect = { x: 20, y: 200, width: 260, height: 30 };
const jordan = { id: "a1", name: "Jordan Avery", street: "1 Infinite Loop", city: "Cupertino", postalCode: "95014", country: "US", email: "jordan@example.com", created: 0, modified: 0 };
const visa = { id: "c1", network: "visa", last4: "1111", name: "Jordan Avery", expMonth: 8, expYear: 2099, created: 0, modified: 0 };
let stop = null;

async function setup({ addresses = [jordan], cards = [visa] } = {}) {
  stop?.();
  S().hydrate({});
  const w = S().createWindow({ url: "https://shop.example/checkout" });
  const tabId = S().windows[w].tabIds[0];
  native.autofillFakes.addresses = addresses;
  native.autofillFakes.cards = cards;
  native.autofillFakes.fills = [];
  native.autofillFakes.nextFill = { filled: true };
  native.vaultFakes.dropdownClaims = [];
  stop = menu.startAutofillMenus();
  return tabId;
}

const focus = (tabId, over = {}) => native.emitEvent("autofill.field", { tabId, focused: true, trigger: "focus", kind: "address", part: "name", rect, ...over });
const ask = (tabId, over = {}) => focus(tabId, { trigger: "ask", ...over });
const claimed = () => native.vaultFakes.dropdownClaims.at(-1)?.kinds ?? [];

test("focusing a field with nothing saved claims nothing and opens nothing, so Chrome's own list shows", async () => {
  const tabId = await setup({ addresses: [] });
  focus(tabId);
  await settle();
  ask(tabId);
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  assert.deepEqual(claimed(), []);
});

test("focus only claims Chrome's list; Ardia's menu opens when the field is clicked, as Chrome's would", async () => {
  const tabId = await setup();
  focus(tabId);
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  assert.deepEqual(claimed(), ["address"]);
  ask(tabId);
  await settle();
  const open = menu.autofillMenuOf(tabId);
  assert.equal(open?.kind, "address");
  assert.equal(open?.selected, 0);
});

test("Escape closes the menu and hands that field back to Chrome until it's focused again", async () => {
  const tabId = await setup();
  focus(tabId);
  ask(tabId);
  await settle();
  native.emitEvent("autofill.menuKey", { tabId, key: "Escape", epoch: "fieldMenu-test" });
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  assert.deepEqual(claimed(), []);
  ask(tabId);
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  focus(tabId, { part: "email" });
  ask(tabId, { part: "email" });
  await settle();
  assert.ok(menu.autofillMenuOf(tabId));
});

test("Enter fills the highlighted address through the engine and closes", async () => {
  const tabId = await setup();
  focus(tabId);
  ask(tabId);
  await settle();
  native.emitEvent("autofill.menuKey", { tabId, key: "Enter", epoch: "fieldMenu-test" });
  await settle();
  await settle();
  assert.deepEqual(native.autofillFakes.fills.map(({ tabId: t, kind, id }) => ({ tabId: t, kind, id })), [{ tabId, kind: "address", id: "a1" }]);
  assert.equal(menu.autofillMenuOf(tabId), null);
  ask(tabId);
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null, "the same field stays quiet right after a fill");
});

test("a declined card check keeps the menu open with a short reason", async () => {
  const tabId = await setup();
  native.autofillFakes.nextFill = { filled: false, declined: true };
  focus(tabId, { kind: "card", part: "number" });
  ask(tabId, { kind: "card", part: "number" });
  await settle();
  native.emitEvent("autofill.menuKey", { tabId, key: "Enter", epoch: "fieldMenu-test" });
  await settle();
  await settle();
  const open = menu.autofillMenuOf(tabId);
  assert.equal(open?.busy, null);
  assert.match(open?.error ?? "", /Touch ID/);
});

test("a card fill the page moved away from during Touch ID closes the menu without an error", async () => {
  const tabId = await setup();
  const { takeAutofillCounts } = await import("../telemetry/autofillCounts.ts");
  takeAutofillCounts();
  native.autofillFakes.nextFill = { filled: false, moved: true };
  focus(tabId, { kind: "card", part: "number" });
  ask(tabId, { kind: "card", part: "number" });
  await settle();
  native.emitEvent("autofill.menuKey", { tabId, key: "Enter", epoch: "fieldMenu-test" });
  await settle();
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  const counts = takeAutofillCounts();
  assert.equal(counts.autofill_card_fills_moved, 1);
  assert.equal(counts.autofill_fills_failed, 0);
});

test("leaving the field releases Chrome's list and closes the menu", async () => {
  const tabId = await setup();
  focus(tabId);
  ask(tabId);
  await settle();
  native.emitEvent("autofill.field", { tabId, focused: false });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(menu.autofillMenuOf(tabId), null);
  assert.deepEqual(claimed(), []);
});

test("closing the tab forgets its field and menu", async () => {
  const tabId = await setup();
  focus(tabId);
  ask(tabId);
  await settle();
  S().closeTab(tabId);
  await settle();
  assert.equal(menu.autofillMenuOf(tabId), null);
  assert.equal(menu.autofillFieldOf(tabId), null);
  stop?.();
});
