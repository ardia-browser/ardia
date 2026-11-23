import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const codes = await import("./codes.ts");
const { usePlugins } = await import("../plugins/store.ts");
usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: false };
const provider = { id: "1password", name: "1Password", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const login = (id, username, hasTotp) => ({ provider: "1password", id, title: `Google ${id}`, username, urls: ["https://accounts.google.com"], ...(hasTotp === undefined ? {} : { hasTotp }) });
const settle = () => new Promise((r) => setTimeout(r, 0));
const handle = { setVaultMenu: async () => undefined, focus: async () => undefined };
const field = { frameId: "f1", origin: "https://accounts.google.com", main: true, kind: "otp", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: false };

async function siteWith(items, cached) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://accounts.google.com/signin" });
  const tabId = S().windows[w].tabIds[0];
  webviews.set(tabId, handle);
  native.vaultFakes.providers = [provider];
  native.vaultFakes.items = items;
  native.vaultFakes.cachedCodes = cached;
  native.vaultFakes.codesForCalls.length = 0;
  native.vaultFakes.totpCalls = 0;
  native.vaultFakes.totpAsked.length = 0;
  S().updateSettings({ vaultSuggestOnFocus: true });
  store.clearVaultIndex();
  codes.clearVaultCodes();
  await store.loadVaultProviders();
  await store.loadSiteItems("https://accounts.google.com");
  return tabId;
}

async function openOn(tabId) {
  menu.noteVaultField(tabId, field);
  if (!menu.vaultMenuOf(tabId)) await settle();
}

const otpRows = (tabId) => menu.rowsOfMenu(menu.vaultMenuOf(tabId)).filter((r) => r.kind === "otp");

test("every cached code is in hand before the menu's first frame, read in one native call with the site's logins", async () => {
  const items = [login("a", "sam", true), login("b", "kim", undefined), login("c", "pat", undefined), login("d", "lee", true)];
  const tabId = await siteWith(items, { "1password/a": "111111", "1password/b": "222222", "1password/c": "333333", "1password/d": "444444" });
  assert.equal(native.vaultFakes.codesForCalls.length, 1);
  await openOn(tabId);
  const rows = otpRows(tabId);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(typeof codes.useVaultCodes.getState()[`1password/${row.item.id}`], "object", `${row.item.id} has its code on the first frame`);
  await settle();
  assert.equal(native.vaultFakes.totpCalls, 0, "no code waits on the CLI");
});

test("a login native knows has no code reads as none at once, and only a never-seen one asks the CLI for its code", async () => {
  const tabId = await siteWith([login("none1", "sam", undefined), login("unseen1", "kim", undefined)], { "1password/none1": "" });
  await openOn(tabId);
  await settle();
  assert.equal(codes.useVaultCodes.getState()["1password/none1"], "none");
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(native.vaultFakes.totpAsked.includes("1password/unseen1"), "the never-seen login asks for its code");
  assert.ok(!native.vaultFakes.totpAsked.includes("1password/none1"), "a login known to have no code never asks the CLI");
});
