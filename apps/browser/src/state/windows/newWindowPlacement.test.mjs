import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SETTINGS, SETTING_SPECS, parseSettings } = await import("../settings/settings.ts");
const { CONFIG_SETTING_KEYS } = await import("../settings/configAllowlist.ts");
const { createWindowSync } = await import("./windowSync.ts");

const S = () => useBrowser.getState();
const PROFILES = { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } };
const reset = () => S().hydrate({ profiles: PROFILES, profileOrder: ["default"], windows: {}, tabs: {} });

function fakePort() {
  const calls = [];
  const port = {
    open: (id, options, lightsCenter) => calls.push(["open", id, options, lightsCenter]),
    close: (id) => calls.push(["close", id]),
    setTitle: (id, title) => calls.push(["setTitle", id, title]),
    windowIds: async () => [],
    restoreFullScreen: () => {},
    onEvent: () => {},
    releaseProfile: () => {},
  };
  return { port, opens: () => calls.filter((c) => c[0] === "open") };
}

function start(native) {
  return createWindowSync({
    port: native.port,
    getState: S,
    isQuitting: () => false,
    lightsCenter: () => [2, 2],
    isUtilityWindow: () => false,
  });
}

test("newWindowPlacement defaults to cascade, accepts beside and equal, is synced and config-allowed", () => {
  assert.equal(DEFAULT_SETTINGS.newWindowPlacement, "cascade");
  assert.equal(SETTING_SPECS.newWindowPlacement.synced, true);
  assert.ok(CONFIG_SETTING_KEYS.includes("newWindowPlacement"));
  assert.equal(parseSettings({ newWindowPlacement: "beside" }).newWindowPlacement, "beside");
  assert.equal(parseSettings({ newWindowPlacement: "equal" }).newWindowPlacement, "equal");
  assert.equal(parseSettings({ newWindowPlacement: "invalid" }).newWindowPlacement, "cascade");
});

test("windowSync forwards non-default newWindowPlacement for regular and private windows without a saved frame", () => {
  reset();
  S().updateSettings({ newWindowPlacement: "equal" });
  const a = S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());

  let prev = S();
  const b = S().createWindow();
  sync.sync(S(), prev);
  assert.equal(native.opens().at(-1)[1], b);
  assert.equal(native.opens().at(-1)[2].placement, "equal");

  prev = S();
  S().updateSettings({ newWindowPlacement: "beside" });
  const priv = S().createWindow({ kind: "private" });
  sync.sync(S(), prev);
  assert.equal(native.opens().at(-1)[1], priv);
  assert.equal(native.opens().at(-1)[2].placement, "beside");

  prev = S();
  const positioned = S().createWindow({ frame: [100, 100, 1200, 800] });
  sync.sync(S(), prev);
  assert.equal(native.opens().at(-1)[1], positioned);
  assert.equal(native.opens().at(-1)[2].placement, undefined);

  prev = S();
  const small = S().createWindow({ kind: "small" });
  sync.sync(S(), prev);
  assert.equal(native.opens().at(-1)[1], small);
  assert.equal(native.opens().at(-1)[2].placement, undefined);

  prev = S();
  S().updateSettings({ newWindowPlacement: "cascade" });
  const c = S().createWindow();
  sync.sync(S(), prev);
  assert.equal(native.opens().at(-1)[1], c);
  assert.equal(native.opens().at(-1)[2].placement, undefined);
});
