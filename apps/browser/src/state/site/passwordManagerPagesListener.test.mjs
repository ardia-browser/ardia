import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const pm = await import("./passwordManager.ts");
const offer = await import("./offerToSave.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

let live = 0;
let counting = false;
const subscribe = usePages.subscribe;
usePages.subscribe = Object.assign((listener) => {
  if (!counting) return subscribe(listener);
  live++;
  const stop = subscribe(listener);
  let stopped = false;
  return () => {
    if (!stopped) live--;
    stopped = true;
    stop();
  };
}, subscribe);

test("with no password manager plugin on, the password manager holds no pages-store listener", async () => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  stub.pluginHost.folders = [{ name: "system-passwords", status: "ok", bundled: true, text: MANIFEST.replace('"password-manager"', '"system-passwords"') }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  counting = true;
  pm.startPasswordManager();
  await settle();
  assert.equal(offer.pendingOfferToSave(), 0);
  assert.equal(live, 0);
});

test("a pending offer-to-save write watches pages while it waits, and lets go once it lands", async () => {
  const seen = [];
  const stop = offer.watchPendingOfferToSave((pending) => seen.push(pending));
  offer.followMode("default", "plugin:system-passwords");
  assert.equal(live, 1);
  await settle();
  assert.equal(offer.pendingOfferToSave(), 0);
  assert.equal(live, 0);
  assert.deepEqual(seen, [true, false]);
  stop();
});
