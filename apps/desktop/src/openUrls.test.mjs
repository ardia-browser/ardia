import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listenForOpenUrls, OPEN_URLS_LISTEN } from "./openUrls.ts";
import { LINKS_FROM_OTHER_APPS } from "./hostCapabilities.ts";

function nativeHost(capabilities) {
  const calls = [];
  return { calls, bootstrap: { windowId: "main", capabilities }, invoke(method, args) { calls.push([method, args]); return Promise.resolve(null); } };
}

test("a window tells the host it listens for links from other apps only when the host delivers them", () => {
  const old = nativeHost(["ArdiaTabs.unclaimedTabs"]);
  assert.equal(listenForOpenUrls(old), false);
  assert.deepEqual(old.calls, []);
  const current = nativeHost([LINKS_FROM_OTHER_APPS, OPEN_URLS_LISTEN]);
  assert.equal(listenForOpenUrls(current), true);
  assert.deepEqual(current.calls, [[OPEN_URLS_LISTEN, { args: [] }]]);
});

test("the names match the engine's, and the window listens after the shared listener is registered", () => {
  const core = readFileSync(new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_open_urls.h", import.meta.url), "utf8");
  assert.ok(core.includes(`kEventCapability[] = "${LINKS_FROM_OTHER_APPS}"`));
  assert.ok(core.includes(`kListenCall[] = "${OPEN_URLS_LISTEN}"`));
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  assert.ok(main.indexOf("startNativeSync();") < main.indexOf("listenForOpenUrls(ardiaHost);"));
  assert.ok(main.indexOf("startNativeSync();") > 0);
});
