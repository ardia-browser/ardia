import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript");
const source = readFileSync(new URL("./SettingsWindow.tsx", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const panes = ["general", "profiles", "tabs", "appearance", "automations", "plugins", "shortcuts", "advanced"];
const dummy = () => null;
const unknownModule = new Proxy({}, { get: () => dummy });

function anchorRegistry() {
  const source = readFileSync(new URL("./anchors.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported = {};
  new Function("exports", code)(exported);
  return exported;
}

function fixture() {
  let nav = { pane: "general", profileId: null, detail: null, back: [], forward: [] };
  let query = "";
  let reveal = null;
  let refIndex = 0;
  let effectIndex = 0;
  let frameId = 0;
  const refs = [];
  const effects = [];
  const pendingEffects = [];
  const frames = new Map();
  const flashes = [];
  const scrolls = [];
  const anchors = anchorRegistry();
  const useRef = (value) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: value });
  const useEffect = (run, deps) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: run() };
    });
  };
  const currentSettingsSearch = () => ({ query, reveal });
  const ui = new Proxy({ space: { ml: 12, m: 8, l: 16, xxxl: 24 }, NativeFormContext: { Provider: dummy } }, { get: (own, key) => own[key] ?? dummy });
  const modules = {
    "react": { useEffect, useLayoutEffect: () => {}, useRef, useState: value => [value, () => {}] },
    "react/jsx-runtime": localRequire("react/jsx-runtime"),
    "react-native": { ScrollView: dummy, View: dummy, StyleSheet: { hairlineWidth: 1, absoluteFill: {} } },
    "../ui": ui,
    "../ui/theme": { useTheme: () => ({}) },
    "../../state/browser/hooks": { useProfile: () => undefined },
    "../../state/plugins/hooks": { usePluginTitle: id => id ? `Plugin: ${id}` : null },
    "../../state/settings/paneData": { usePaneLoaded: () => false, preparePane: async () => {} },
    "../../state/settings/settingsWindows": {
      useSettingsNav: () => nav, currentSettingsPlace: () => nav, SETTINGS_WINDOW_ID: "settings",
    },
    "../../state/settings/searchState": {
      useSettingsSearch: select => select(currentSettingsSearch()), currentSettingsSearch,
      clearSettingsReveal: () => { reveal = null; },
      flashSetting: id => { flashes.push(id); reveal = null; },
      settingsSearchHost: () => {},
    },
    "../../state/settings/sheet": { useSettingsSheet: select => select({ sheet: null }) },
    "./settingsIndex": {
      PANES: panes.map(id => ({ id, title: id, icon: id, tint: "gray" })), paneTitle: id => id,
      findSetting: id => ({ pane: id.split(".")[0] }), resolveSettingId: id => id,
    },
    "./anchors": anchors,
    "./Form": { SettingsPaneContext: { Provider: dummy } },
    "./useSettingsColors": { useSettingsColors: () => ({}) },
    "./tokens": { settingsLayout: { sidebarWidth: 214, paneBottom: 40, paneMaxWidth: 600 }, paneTile: { size: 20, radius: 5, symbol: 11 }, paneTints: { gray: "#888", ink: "#fff" } },
    "../pages/tokens": { pageToolbar: { window: { height: 52 } } },
    "../../lib/windowChrome": { WINDOW_CHROME: { leadingWidth: 0 }, WINDOW_CONTROLS: { edge: 0, gap: 0, regular: 32 }, windowControlsWidth: () => 150 },
  };
  const exported = {};
  new Function("require", "exports", "requestAnimationFrame", "cancelAnimationFrame", javascript)(
    name => modules[name] ?? unknownModule, exported,
    callback => { frames.set(++frameId, callback); return frameId; },
    id => frames.delete(id),
  );
  return {
    navigate(pane, profileId = null, detail = null) { nav = { ...nav, pane, profileId, detail }; },
    search(value) { query = value; },
    reveal(id) { reveal = { id }; },
    pending: () => reveal?.id,
    anchors, flashes, scrolls,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
    },
    render() {
      refIndex = effectIndex = 0;
      const tree = exported.SettingsWindow();
      for (const node of elements(tree)) {
        if (node.props?.collapsable === false) node.props.ref.current = {};
        if (node.props?.scrollEventThrottle) node.props.ref.current = { scrollTo: position => scrolls.push(position) };
      }
      pendingEffects.splice(0).forEach(run => run());
      return tree;
    },
  };
}

function elements(root) {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap(elements);
  return [root, ...elements(root.props?.children)];
}

function content(tree) {
  return elements(tree).find(node => node.type?.name === "Pane");
}

test("each cold settings target renders its own pane and matching selected row immediately", () => {
  const app = fixture();
  for (const pane of panes) {
    app.navigate(pane);
    const tree = app.render();
    assert.equal(content(tree)?.props.pane, pane);
    const selected = elements(tree).filter(node => node.type?.name === "SidebarItem" && node.props.selected);
    assert.deepEqual(selected.map(node => node.props.title), [pane]);
  }
});

test("rapid navigation and profile details cannot render the previous pane", () => {
  const app = fixture();
  for (const pane of ["advanced", "general", "profiles", "shortcuts", "appearance", "general"]) {
    app.navigate(pane);
    assert.equal(content(app.render())?.props.pane, pane);
  }
  app.navigate("profiles", "work", "extensions");
  assert.equal(content(app.render())?.props.profileId, "work");
  assert.equal(content(app.render())?.props.detail, "extensions");
});

test("search hides navigation rows without making the content selection stale", () => {
  const app = fixture();
  app.search("toolbar");
  app.navigate("appearance");
  assert.equal(content(app.render())?.props.pane, "appearance");
  app.search("");
  const selected = elements(app.render()).filter(node => node.type?.name === "SidebarItem" && node.props.selected);
  assert.deepEqual(selected.map(node => node.props.title), ["appearance"]);
});

test("plugin details switch with their title while the pane loads", () => {
  const app = fixture();
  app.navigate("plugins", null, "example");
  const tree = app.render();
  assert.equal(content(tree)?.props.pane, "plugins");
  assert.equal(content(tree)?.props.detail, "example");
  assert.ok(elements(tree).some(node => node.props?.children === "Plugin: example"));
});

test("a Settings search reveal scrolls to a resource-backed row once it registers", () => {
  const app = fixture();
  const id = "appearance.appIcon";
  app.navigate("appearance");
  app.reveal(id);
  assert.equal(content(app.render())?.props.pane, "appearance");
  app.flushFrames();
  assert.equal(app.pending(), id);
  assert.deepEqual(app.flashes, []);
  app.anchors.registerAnchor(id, { measureLayout: (_view, ok) => ok(0, 240, 10, 30) });
  app.flushFrames();
  assert.deepEqual(app.flashes, [id]);
  assert.deepEqual(app.scrolls.map(position => position.y), [240]);
  assert.equal(app.pending(), undefined);
});

test("leaving the target while the resource loads cancels the search reveal", () => {
  const app = fixture();
  const id = "profiles.autofill";
  app.navigate("profiles", "work");
  app.reveal(id);
  app.render();
  app.flushFrames();
  assert.equal(app.pending(), id);
  app.navigate("profiles", "home");
  app.render();
  app.anchors.registerAnchor(id, { measureLayout: () => assert.fail("stale reveal measured") });
  app.flushFrames();
  assert.equal(app.pending(), undefined);
  assert.deepEqual(app.flashes, []);
  assert.deepEqual(app.scrolls, []);
});
