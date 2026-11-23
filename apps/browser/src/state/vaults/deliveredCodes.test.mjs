import assert from "node:assert/strict";
import { mock, test } from "node:test";

const NOW = 1_800_000_000_000;
mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });

const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { adoptDelivered, startDeliveredCodes, useDeliveredCodes } = await import("./deliveredCodes.ts");
const { useVaultCodes } = await import("./codes.ts");
const { watchDeliveredCodes } = await import("./menuCodes.ts");

const MIN = 60_000;
const sent = (id, extra = {}) => ({ id: `delivered.${id}`, source: "messages", sender: "12345", site: null, bound: false, receivedAt: Date.now(), expiresAt: Date.now() + 10 * MIN, ...extra });
const ids = () => useDeliveredCodes.getState().items.map((i) => i.id);
const changed = (state) => adoptDelivered(state);

const setSettings = (patch) => useBrowser.setState((s) => ({ settings: { ...s.settings, ...patch } }));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
setSettings({ vaultSuggestDeliveredCodes: false, vaultSuggestCodes: true });
startDeliveredCodes();

test("native is told what to do at launch and on every change of either switch, off included", async () => {
  await settle();
  assert.deepEqual(native.vaultFakes.deliveredTurns, [false], "launch says off even when off, so native never keeps an old on");
  setSettings({ vaultSuggestDeliveredCodes: true });
  setSettings({ vaultSuggestCodes: false });
  setSettings({ vaultSuggestCodes: true });
  setSettings({ vaultSuggestDeliveredCodes: false });
  await settle();
  assert.deepEqual(native.vaultFakes.deliveredTurns, [false, true, false, true, false]);
});

test("the engine's event replaces the list, newest first, and keeps unchanged items as they were", async () => {
  await changed({ access: "on", codes: [sent("a", { receivedAt: NOW - MIN }), sent("b")] });
  assert.equal(useDeliveredCodes.getState().access, "on");
  assert.deepEqual(ids(), ["delivered.b", "delivered.a"]);
  const before = useDeliveredCodes.getState().items;
  await changed({ access: "on", codes: [sent("b"), sent("a", { receivedAt: NOW - MIN })] });
  assert.equal(useDeliveredCodes.getState().items, before, "an identical list doesn't re-render the menu");
});

test("a code that leaves the list takes its fetched digits with it", async () => {
  await changed({ access: "on", codes: [sent("c")] });
  useVaultCodes.setState({ "delivered/delivered.c": { code: "123456", period: 600, expiresAt: NOW + 10 * MIN } });
  await changed({ access: "on", codes: [] });
  assert.deepEqual(ids(), []);
  assert.equal(useVaultCodes.getState()["delivered/delivered.c"], undefined);
});

test("each code drops on its own at expiry, without waiting for the engine", async () => {
  await changed({ access: "on", codes: [sent("soon", { expiresAt: Date.now() + 2 * MIN }), sent("later", { receivedAt: Date.now() - MIN, expiresAt: Date.now() + 5 * MIN })] });
  assert.deepEqual(ids(), ["delivered.soon", "delivered.later"]);
  mock.timers.tick(2 * MIN);
  assert.deepEqual(ids(), ["delivered.later"]);
  mock.timers.tick(3 * MIN);
  assert.deepEqual(ids(), []);
});

test("turning off or losing access empties the list whatever the payload holds", async () => {
  await changed({ access: "on", codes: [sent("d")] });
  await changed({ access: "needsAccess", codes: [sent("d")] });
  assert.deepEqual({ access: useDeliveredCodes.getState().access, ids: ids() }, { access: "needsAccess", ids: [] });
  await changed({ access: "off", codes: [] });
  assert.equal(useDeliveredCodes.getState().access, "off");
});

test("a code arriving offers the menu only on a focused code field it is bound to", async () => {
  const offered = [];
  const fields = { bank: { kind: "otp", origin: "https://login.bank.com" }, evil: { kind: "otp", origin: "https://evil.example" }, pass: { kind: "password", origin: "https://bank.com" } };
  const stop = watchDeliveredCodes(() => undefined, () => fields, (tabId) => offered.push(tabId));
  await changed({ access: "on", codes: [sent("hint", { site: "evil.example" })] });
  await changed({ access: "on", codes: [sent("hint", { site: "evil.example" }), sent("bank", { site: "bank.com", bound: true })] });
  stop();
  assert.deepEqual(offered, ["bank"]);
});

test("the engine's event reaches the store, and a new code's digits are there on the row's first frame", async () => {
  native.vaultFakes.cachedCodes["delivered/delivered.fresh"] = "482913";
  const seen = [];
  const stop = useDeliveredCodes.subscribe((st) => {
    if (st.items.some((i) => i.id === "delivered.fresh")) seen.push(useVaultCodes.getState()["delivered/delivered.fresh"]?.code ?? null);
  });
  native.emitEvent("vaults.deliveredCodesChanged", { access: "on", codes: [sent("fresh")] });
  await settle();
  stop();
  assert.deepEqual(ids(), ["delivered.fresh"]);
  assert.equal(seen[0], "482913", "the row never shows a spinner for a code native already has");
});
