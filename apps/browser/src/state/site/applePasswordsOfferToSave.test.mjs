import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const pm = await import("./passwordManager.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

const S = () => useBrowser.getState();
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const chromeOffers = () => stub.profileToggles.user.get("")?.passwords ?? true;

S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
S().createWindow({ url: "https://a.example/", profileId: "default" });
startPlugins();
stub.pluginHost.folders = [];
await lifecycle.rescanPlugins(consentToken());
pm.startPasswordManager();
await settle();

const choose = async (manager) => {
  pm.choosePasswordManager("default", manager);
  await settle();
};

beforeEach(async () => {
  await choose("ardia");
  await setPasswordAutofillFor("", true);
  await settle();
});

test("story 9: Save and fill passwords turned off on Ardia leaves Chrome's offer to save on once Apple Passwords is picked, and off again back on Ardia", async () => {
  await setPasswordAutofillFor("", false);
  await settle();
  assert.equal(chromeOffers(), false, "the user's Off reaches Chrome on Ardia");
  await choose("apple");
  assert.equal(chromeOffers(), true, "Apple Passwords needs Chrome to keep offering to save");
  await choose("ardia");
  assert.equal(chromeOffers(), false, "the user's Off comes back with Ardia");
});

test("story 9: a stored Off on an Apple Passwords profile and a move to None, then Ardia, keeps the user's Off", async () => {
  await setPasswordAutofillFor("", false);
  await settle();
  await choose("apple");
  await choose("none");
  assert.equal(chromeOffers(), false, "None turns Chrome's offer to save off");
  await choose("ardia");
  assert.equal(chromeOffers(), false, "Ardia brings back the user's Off, not an On Ardia made");
});

test("story 9: On stays on through None, Apple Passwords and back to Ardia", async () => {
  await choose("none");
  assert.equal(chromeOffers(), false);
  await choose("apple");
  assert.equal(chromeOffers(), true);
  await choose("ardia");
  assert.equal(chromeOffers(), true);
});
