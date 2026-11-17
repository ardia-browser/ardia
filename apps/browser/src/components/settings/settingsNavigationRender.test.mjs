import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript");
const source = readFileSync(new URL("./SettingsWindow.tsx", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const panes = ["general", "profiles", "tabs", "appearance", "automations", "shortcuts", "advanced"];
const dummy = () => null;
const unknownModule = new Proxy({}, { get: () => dummy });

function fixture() {
  let nav = { pane: "general", profileId: null, detail: null, back: [], forward: [] };
  let query = "";
  const ui = new Proxy({ space: { ml: 12, m: 8, l: 16, xxxl: 24 }, NativeFormContext: { Provider: dummy } }, { get: (own, key) => own[key] ?? dummy });
  const modules = {
    "react": { useEffect: () => {}, useLayoutEffect: () => {}, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    "react/jsx-runtime": localRequire("react/jsx-runtime"),
    "react-native": { ScrollView: dummy, View: dummy, StyleSheet: { hairlineWidth: 1, absoluteFill: {} } },
    "../ui": ui,
    "../ui/theme": { useTheme: () => ({}) },
    "../../state/browser/hooks": { useProfile: () => undefined },
    "../../state/settings/paneData": { usePaneLoaded: () => false, preparePane: async () => {} },
    "../../state/settings/settingsWindows": { useSettingsNav: () => nav, SETTINGS_WINDOW_ID: "settings" },
    "../../state/settings/searchState": { useSettingsSearch: select => select({ query, reveal: null }) },
    "../../state/settings/sheet": { useSettingsSheet: select => select({ sheet: null }) },
    "./settingsIndex": { PANES: panes.map(id => ({ id, title: id, icon: id, tint: "gray" })), paneTitle: id => id },
    "./Form": { SettingsPaneContext: { Provider: dummy } },
    "./useSettingsColors": { useSettingsColors: () => ({}) },
    "./tokens": { settingsLayout: { sidebarWidth: 214, paneBottom: 40, paneMaxWidth: 600 }, paneTile: { size: 20, radius: 5, symbol: 11 }, paneTints: { gray: "#888", ink: "#fff" } },
    "../pages/tokens": { pageToolbar: { window: { height: 52 } } },
    "../../lib/windowChrome": { WINDOW_CHROME: { leadingWidth: 0 }, WINDOW_CONTROLS: { edge: 0, gap: 0, regular: 32 }, windowControlsWidth: () => 150 },
  };
  const exported = {};
  new Function("require", "exports", javascript)(name => modules[name] ?? unknownModule, exported);
  return {
    navigate(pane, profileId = null, detail = null) { nav = { ...nav, pane, profileId, detail }; },
    search(value) { query = value; },
    render: () => exported.SettingsWindow(),
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
