import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const store = await import("./store.ts");
const { noteVaultLoginPage, startVaultWarming } = await import("./warm.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });

const S = () => useBrowser.getState();
S().hydrate({});
const tabIn = () => {
  const w = S().createWindow({ url: "https://github.com/login" });
  return S().windows[w].tabIds[0];
};

const caps = { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: true };
const provider = (state) => ({ id: "1password", name: "1Password", state, capabilities: caps, install: { command: "", url: "" } });
const settle = () => new Promise((r) => setTimeout(r, 0));

const t1 = tabIn();
const t2 = tabIn();
const t3 = tabIn();

test("a login page in a profile that isn't on Ardia reads nothing ahead", async () => {
  await withProviders("unlocked");
  S().updateProfile("default", { passwordManager: "none" });
  try {
    noteVaultLoginPage(t1, { origin: "https://github.com", main: true });
    await settle();
    assert.deepEqual(native.vaultFakes.warmed, []);
  } finally {
    S().updateProfile("default", { passwordManager: "ardia" });
  }
});

async function withProviders(state) {
  native.vaultFakes.providers = [provider(state)];
  native.vaultFakes.items = [];
  native.vaultFakes.warmed.length = 0;
  await store.loadVaultProviders();
}

test("a login page on an insecure origin, or with every manager locked, reads nothing ahead", async () => {
  await withProviders("locked");
  noteVaultLoginPage(t1, { origin: "https://github.com", main: true });
  await withProviders("unlocked");
  noteVaultLoginPage(t1, { origin: "http://github.com", main: true });
  await settle();
  assert.deepEqual(native.vaultFakes.warmed, []);
});

test("a login page reads its site's logins ahead, and an unlock reads the sites of open login pages again", async () => {
  const stop = startVaultWarming();
  try {
    await withProviders("unlocked");
    noteVaultLoginPage(t2, { origin: "https://github.com", main: true });
    await settle();
    assert.deepEqual(native.vaultFakes.warmed, ["https://github.com"]);
    await withProviders("locked");
    native.vaultFakes.providers = [provider("unlocked")];
    await store.loadVaultProviders();
    await settle();
    assert.ok(native.vaultFakes.warmed.includes("https://github.com"), "the unlock warms the open login page's site");
  } finally {
    stop();
  }
});

test("an embedded frame warms its own site but never replaces the tab's top site", async () => {
  const stop = startVaultWarming();
  try {
    await withProviders("unlocked");
    noteVaultLoginPage(t3, { origin: "https://bank.example", main: true });
    noteVaultLoginPage(t3, { origin: "https://ads.example", main: false });
    await settle();
    assert.deepEqual(native.vaultFakes.warmed, ["https://bank.example", "https://ads.example"], "the frame's own site is read ahead once");
    native.vaultFakes.warmed.length = 0;
    native.vaultFakes.providers = [provider("locked")];
    await store.loadVaultProviders();
    native.vaultFakes.providers = [provider("unlocked")];
    await store.loadVaultProviders();
    await settle();
    assert.ok(native.vaultFakes.warmed.includes("https://bank.example"), "an unlock warms the tab's top site");
    assert.ok(!native.vaultFakes.warmed.includes("https://ads.example"), "never the embedded frame's site");
  } finally {
    stop();
  }
});
