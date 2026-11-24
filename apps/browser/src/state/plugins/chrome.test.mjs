import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { switchToTab } = await import("../browser/actions.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { settledStops } = await import("./process.ts");
const { watchingUrlActivation } = await import("./activation.ts");
const { usePluginSurfaces, openPluginSidePanel, openPluginPopover, closePluginPopover, watchingSurfaceWindows } = await import("./surfaces.ts");
const { PLUGIN_CHROME, contributedChrome, usePluginChromeOf } = await import("./chrome.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-chrome-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const COMMANDS_ONLY = { manifest: 2, name: "terminal", title: "Terminal", main: "index.js", permissions: { tabs: "read" }, contributes: { commands: [{ name: "run", title: "Run" }], hooks: ["tab.opening"] } };
const CHROME = {
  manifest: 2,
  name: "reader",
  title: "Reader",
  icon: "book",
  main: "dist/index.js",
  activationEvents: ["onUrl:docs.example.com"],
  permissions: { tabs: "read", network: ["docs.example.com"] },
  contributes: {
    toolbar: [{ id: "go", title: "Reader", icon: "book", view: "quick" }],
    sidebarViews: [{ id: "notes", title: "Notes", icon: "note.text" }],
    panels: [
      { id: "default", title: "Reader", mode: "tab", file: "page/index.html" },
      { id: "chat", title: "Chat", mode: "sidecar", view: "chat" },
    ],
  },
};

async function only(...docs) {
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: JSON.stringify(doc) }));
  await lifecycle.rescanPlugins(consentToken());
  for (const doc of docs) {
    assert.deepEqual(P().listings[doc.name].problems, [], doc.name);
    assert.ok(lifecycle.requestPluginConsent(doc.name));
    assert.ok(lifecycle.enablePlugin(doc.name, P().consent.hash));
  }
  await settle();
}

function countBrowserListeners() {
  let calls = 0;
  const unsubscribe = useBrowser.subscribe(() => calls++);
  return () => (unsubscribe(), calls);
}

test("with no plugin contributing chrome, no plugin surface mounts and a tab switch wakes nothing plugin-side", async () => {
  S().hydrate({});
  await only(COMMANDS_ONLY);
  const w = S().createWindow({ url: "https://a.example/" });
  S().newTab(w, { url: "https://b.example/" });
  S().newTab(w, { url: "https://c.example/" });
  assert.equal(contributedChrome(P()), 0, "commands and hooks draw no chrome");
  const chrome = mount(() => usePluginChromeOf(w));
  assert.equal(chrome.value, 0);
  assert.equal(watchingUrlActivation(), false, "no URL-activated plugin, so tab changes aren't watched");
  assert.equal(watchingSurfaceWindows(), false, "no surface is open, so window changes aren't watched");
  const switches = countBrowserListeners();
  const tabs = S().windows[w].tabIds;
  for (const id of [...tabs, ...tabs]) switchToTab(id);
  assert.ok(switches() > 0, "the switches did change the store");
  assert.equal(chrome.renders, 1, "the window's plugin chrome never re-rendered on a tab switch");
  assert.equal(watchingUrlActivation() || watchingSurfaceWindows(), false);
});

test("a plugin's toolbar, sidebar views and side panels turn on only the chrome they need, and the watches end with them", async () => {
  S().hydrate({});
  await only(CHROME);
  const w = S().createWindow({ url: "https://a.example/" });
  const chrome = mount(() => usePluginChromeOf(w));
  assert.equal(chrome.value, PLUGIN_CHROME.toolbar | PLUGIN_CHROME.sidebar | PLUGIN_CHROME.panels);
  assert.equal(watchingUrlActivation(), true, "an onUrl plugin watches tab addresses");
  assert.equal(watchingSurfaceWindows(), false);
  assert.ok(openPluginPopover(w, "reader", "go", "quick", { x: 0, y: 0, width: 28, height: 28 }));
  assert.equal(chrome.value & PLUGIN_CHROME.overlays, PLUGIN_CHROME.overlays, "an open popover mounts the overlays");
  assert.equal(watchingSurfaceWindows(), true);
  closePluginPopover(w);
  assert.equal(chrome.value & PLUGIN_CHROME.overlays, 0);
  assert.equal(watchingSurfaceWindows(), false, "the window watch ends with the last open surface");
  assert.ok(openPluginSidePanel(w, "reader", "chat"));
  assert.equal(watchingSurfaceWindows(), true);
  S().closeWindow(w);
  assert.equal(usePluginSurfaces.getState().sidePanels[w], undefined, "closing the window still drops its panel");
  assert.equal(watchingSurfaceWindows(), false);
  lifecycle.disablePlugin("reader", consentToken());
  await settledStops();
  assert.equal(contributedChrome(P()), 0);
  assert.equal(watchingUrlActivation(), false, "turning the plugin off stops the tab watch");
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const WIRING = {
  "../../App.tsx": { PluginSidePanel: "pluginPanels", PluginOverlays: "pluginOverlays" },
  "../../components/toolbar/Toolbar.tsx": { PluginToolbarItems: "pluginToolbar" },
  "../../components/sidebar/AddressBar.tsx": { PluginToolbarItems: "pluginToolbar" },
  "../../components/sidebar/PageRows.tsx": { PluginSidebarViews: "pluginViews" },
};

test("the window mounts each plugin surface only behind its chrome flag, and plugin chrome never reads the whole browser store", () => {
  for (const [path, components] of Object.entries(WIRING)) {
    const source = read(path);
    assert.match(source, /usePluginChrome\(PLUGIN_CHROME\.\w+\)/, path);
    for (const [component, flag] of Object.entries(components)) {
      const uses = [...source.matchAll(new RegExp(`<${component}\\b`, "g"))];
      assert.ok(uses.length, `${path} renders ${component}`);
      for (const use of uses) assert.match(source.slice(Math.max(0, use.index - 200), use.index), new RegExp(`\\b${flag}\\b[^?]*\\?\\s*$`), `${path}: ${component} is behind ${flag}`);
    }
  }
  for (const file of ["PluginToolbarItems", "PluginSidebarViews", "PluginOverlays", "PluginSidePanel"]) assert.doesNotMatch(read(`../../components/plugins/${file}.tsx`), /useBrowser\(/, file);
  assert.doesNotMatch(read("./hooks.ts"), /usePluginWindowEligible = [^\n]*useBrowser\(/, "window eligibility is a keyed watch on the window record");
});
