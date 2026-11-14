import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { configFolder, emitConfigChange } = await import("../../test-native/shell.ts");
const { startConfigFiles, reconcileConfig, resetConfigFilesForTests, problemsToast } = await import("./configFiles.ts");
const { useBasePalette } = await import("./basePalette.ts");
const { useToasts, showToast, hideKeyedToast } = await import("../app/toasts.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");
const { colorRoles, font, radius, weight, lineHeight } = await import("../../components/ui/tokens.ts");
const { layout } = await import("../../components/ui/theme.ts");
const { activeLook, iconName } = await import("../../lib/activeLook.ts");
const { DEFAULT_LOOK } = await import("../../lib/themeLook.ts");
const { resetSidebarWidth } = await import("../sidebar/actions.ts");
const { takeConfigProblemToastCounts } = await import("../telemetry/configProblemToasts.ts");

const S = () => useBrowser.getState();
const files = configFolder.files;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const elapse = async (t, ms) => {
  await flush();
  t.mock.timers.tick(ms);
  await flush();
};
firstWindowCommitted();
const writeConfig = (doc) => files.set("config.json", typeof doc === "string" ? doc : JSON.stringify(doc));

function fresh(settings = {}) {
  resetConfigFilesForTests();
  files.clear();
  warnings.length = 0;
  S().hydrate({ settings });
}

test("at launch the file's settings apply through updateSettings, so they count as chosen and sync", () => {
  fresh({ selectedTabGlow: "off" });
  writeConfig({ settings: { selectedTabGlow: "soft", tabLayout: "top" } });
  startConfigFiles(colorRoles);
  assert.equal(S().settings.selectedTabGlow, "soft");
  assert.equal(S().settings.tabLayout, "top");
  assert.ok(S().settingsMeta.chosen.includes("tabLayout"));
});

test("a change made in the app stands until the file changes; every change event re-reads and puts the file's value back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  writeConfig({ settings: { tabLayout: "top" } });
  startConfigFiles(colorRoles);
  await elapse(t, 0);
  await elapse(t, 100);
  S().updateSettings({ tabLayout: "sidebar" });
  assert.equal(S().settings.tabLayout, "sidebar");
  S().updateSettings({ tabLayout: "sidebar" }, { fromSync: true });
  await elapse(t, 150);
  assert.equal(S().settings.tabLayout, "sidebar", "a sync arrival doesn't trigger a re-apply");
  emitConfigChange();
  emitConfigChange();
  await elapse(t, 100);
  assert.equal(S().settings.tabLayout, "top", "the same file, rewritten, is applied again");
  assert.ok(configFolder.watched.at(-1).includes("config.json"));
  assert.ok(configFolder.schemaWrites.length >= 1);
});

test("taking a key out of the file, or deleting the file, keeps the current value", () => {
  fresh();
  writeConfig({ settings: { tabLayout: "top" } });
  startConfigFiles(colorRoles);
  writeConfig({ settings: {} });
  reconcileConfig();
  assert.equal(S().settings.tabLayout, "top");
  files.delete("config.json");
  reconcileConfig();
  assert.equal(S().settings.tabLayout, "top");
});

test("a broken file changes nothing, applies what's valid in a fixable one, and reports each problem once", async () => {
  fresh();
  const window = S().createWindow({ url: "https://a.com/" });
  writeConfig('{ "settings": { "tabLayout": "top" ');
  startConfigFiles(colorRoles);
  await wait(10);
  assert.equal(S().settings.tabLayout, "sidebar");
  assert.equal(useToasts.getState().toasts[window].title, "config.json has a problem");
  assert.match(useToasts.getState().toasts[window].message, /^isn't valid JSON/);
  writeConfig({ settings: { tabLayout: "top", selectedTabGlow: "bright" } });
  reconcileConfig();
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(useToasts.getState().toasts[window].message, "selectedTabGlow must be full, soft or off");
  const shown = useToasts.getState().toasts[window].id;
  reconcileConfig();
  assert.equal(useToasts.getState().toasts[window].id, shown, "the same problem isn't toasted again");
  assert.equal(warnings.filter((w) => w.includes("selectedTabGlow")).length, 1);
});

test("the problem toast stays up while the file is wrong, stays dismissed for the same problems, and goes once they're fixed", async () => {
  fresh();
  const window = S().createWindow({ url: "https://a.com/" });
  writeConfig({ settings: { selectedTabGlow: "bright" } });
  takeConfigProblemToastCounts();
  startConfigFiles(colorRoles);
  await wait(10);
  const toast = () => useToasts.getState().toasts[window];
  assert.equal(toast().sticky, true);
  assert.equal(toast().action.title, "Dismiss");
  toast().action.run();
  useToasts.setState({ toasts: { [window]: null } });
  assert.deepEqual(takeConfigProblemToastCounts(), { config_problem_toasts: 1, config_problem_toast_dismissals: 1 });
  reconcileConfig();
  assert.equal(toast(), null, "dismissed, and nothing new is wrong");
  writeConfig({ settings: { selectedTabGlow: "bright", tabLayout: "middle" } });
  reconcileConfig();
  assert.equal(toast().title, "config.json has 2 problems", "a new problem shows every problem again");
  writeConfig({ settings: { tabLayout: "middle" } });
  reconcileConfig();
  assert.equal(toast().title, "config.json has a problem", "a fixed problem leaves the toast in place with what's left");
  writeConfig({ settings: {} });
  reconcileConfig();
  assert.equal(toast(), null, "fixing the file takes the toast down");
  assert.deepEqual(takeConfigProblemToastCounts(), { config_problem_toasts: 1, config_problem_toast_dismissals: 0 }, "updating it in place isn't another showing");
});

test("the problem toast waits for another toast to go instead of taking its slot, and comes back after one replaces it", async () => {
  fresh();
  const window = S().createWindow({ url: "https://a.com/" });
  startConfigFiles(colorRoles);
  await wait(10);
  showToast(window, "Closed 3 tabs", undefined, { action: { title: "Undo", run() {} } });
  writeConfig({ settings: { selectedTabGlow: "bright" } });
  reconcileConfig();
  assert.equal(useToasts.getState().toasts[window].title, "Closed 3 tabs", "the Undo toast keeps its slot");
  useToasts.setState({ toasts: { [window]: null } });
  assert.equal(useToasts.getState().toasts[window].title, "config.json has a problem", "shown once the slot is free");
  showToast(window, "Translating", undefined, { key: "translate-progress", sticky: true });
  hideKeyedToast(window, "translate-progress");
  assert.equal(useToasts.getState().toasts[window].title, "config.json has a problem", "back after the toast that replaced it goes");
});

test("dismissing holds while the same problems stand, however they're reordered or trimmed", async () => {
  fresh();
  const window = S().createWindow({ url: "https://a.com/" });
  writeConfig({ theme: "demo" });
  files.set("themes/demo.json", JSON.stringify({ colours: {}, fonts: {} }));
  startConfigFiles(colorRoles);
  await wait(10);
  assert.equal(useToasts.getState().toasts[window].message, "colours and fonts aren't theme keys (dark, light, type, metrics, layout, icons)");
  useToasts.setState({ toasts: { [window]: null } });
  files.set("themes/demo.json", JSON.stringify({ fonts: {}, colours: {} }));
  reconcileConfig();
  assert.equal(useToasts.getState().toasts[window], null, "reordered");
  files.set("themes/demo.json", JSON.stringify({ fonts: {} }));
  reconcileConfig();
  assert.equal(useToasts.getState().toasts[window], null, "one of them fixed");
});

test("problems found before any window opens show in the first window that does", async () => {
  fresh();
  assert.equal(S().windowOrder.length, 0);
  writeConfig({ settings: { selectedTabGlow: "bright" } });
  startConfigFiles(colorRoles);
  await wait(10);
  const window = S().createWindow({ url: "https://a.com/" });
  assert.equal(useToasts.getState().toasts[window]?.title, "config.json has a problem");
});

test("the problem toast names the file once and sums up the rest", () => {
  assert.deepEqual(problemsToast(["themes/demo.json: type.family must be a font name", "themes/demo.json: metrics.rowHeight must be a number from 24 to 56", "themes/demo.json: icons.plus has \"Plus\", which isn't an SF Symbol name"]), {
    title: "themes/demo.json has 3 problems",
    message: "type.family must be a font name; metrics.rowHeight must be a number from 24 to 56; and 1 more (ardia config check lists them all)",
  });
  assert.deepEqual(problemsToast(["themes/demo.json: type.famly isn't a type key (family, mono, scale, sizes, weights)", "themes/demo.json: type.font isn't a type key (family, mono, scale, sizes, weights)", "themes/demo.json: icons isn't a theme key (dark, light)"]).message, "type.famly and type.font aren't type keys (family, mono, scale, sizes, weights); icons isn't a theme key (dark, light)");
  assert.deepEqual(problemsToast(["config.json: tabLayout must be sidebar or top", "themes/demo.json: dark.accent isn't a colour"]), {
    title: "Your config files have 2 problems",
    message: "config.json: tabLayout must be sidebar or top; themes/demo.json: dark.accent isn't a colour",
  });
});

test("the theme's roles become the base palette with a new revision, and an unparseable edit keeps the last good version", () => {
  fresh();
  writeConfig({ theme: "nord" });
  files.set("themes/nord.json", JSON.stringify({ dark: { accent: "#88C0D0" } }));
  startConfigFiles(colorRoles);
  const first = useBasePalette.getState().palette;
  assert.equal(first.dark.accent, "#88C0D0");
  assert.equal(first.light.accent, colorRoles.light.accent);
  files.set("themes/nord.json", '{ "dark": { "accent": ');
  reconcileConfig();
  assert.equal(useBasePalette.getState().palette, first, "nothing changed, so no new revision");
  files.set("themes/nord.json", JSON.stringify({ dark: { accent: "#123456" } }));
  reconcileConfig();
  const second = useBasePalette.getState().palette;
  assert.equal(second.dark.accent, "#123456");
  assert.ok(second.revision > first.revision);
  writeConfig({ theme: null });
  reconcileConfig();
  assert.equal(useBasePalette.getState().palette, null);
  writeConfig({ theme: "gone" });
  reconcileConfig();
  assert.equal(useBasePalette.getState().palette, null);
  assert.ok(warnings.some((w) => w.includes("config.json: theme gone has no file themes/gone.json")));
});

test("an edit between the launch read and the watcher arming is picked up once the watcher is armed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  writeConfig({ settings: { selectedTabGlow: "soft" } });
  let arm;
  configFolder.arming = new Promise((resolve) => (arm = resolve));
  startConfigFiles(colorRoles);
  writeConfig({ settings: { selectedTabGlow: "off" } });
  await elapse(t, 150);
  assert.equal(S().settings.selectedTabGlow, "soft", "no event reaches an unarmed watcher");
  arm();
  await elapse(t, 100);
  assert.equal(S().settings.selectedTabGlow, "off");
  configFolder.arming = null;
});

test("restoreSession from the file decides the launch restore, both ways", async () => {
  const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
  startPersistence();
  const { configRestoreSession } = await import("./configFiles.ts");
  const savedWith = (restoreSession) => {
    fresh();
    S().createWindow({ url: "https://a.com/" });
    S().updateSettings({ restoreSession });
    flushPersistence();
  };
  savedWith(false);
  writeConfig({ settings: { restoreSession: true } });
  assert.equal(configRestoreSession(), true);
  assert.ok(loadSession({ restoreSession: configRestoreSession() }).windowOrder.length > 0, "saved false, file true: the windows come back");
  savedWith(true);
  writeConfig({ settings: { restoreSession: false } });
  assert.equal(loadSession({ restoreSession: configRestoreSession() }).windowOrder.length, 0, "saved true, file false: nothing is restored");
  writeConfig({ settings: { restoreSession: "no" } });
  assert.equal(configRestoreSession(), undefined, "an invalid value leaves the saved setting in charge");
  files.delete("config.json");
  assert.equal(configRestoreSession(), undefined);
});

test("a theme's look applies live through the tokens, keeps the last good version, and going back gives Ardia's own look", () => {
  fresh();
  writeConfig({ theme: "roomy" });
  files.set("themes/roomy.json", JSON.stringify({ type: { family: "Avenir Next", sizes: { body: 15 }, weights: { medium: "600" } }, metrics: { rowHeight: 40, radius: { row: 14 } }, icons: { plus: "plus.circle" } }));
  const defaults = { font: font.body, radius: radius.chrome, row: layout.rowHeight, line: lineHeight.body, weight: weight.medium };
  assert.deepEqual(defaults, { font: { fontSize: 13 }, radius: 10, row: 34, line: 16, weight: "500" });
  startConfigFiles(colorRoles);
  const first = useBasePalette.getState();
  assert.notEqual(first.palette, null, "a look-only theme still gives a new palette, so every themed view re-renders");
  assert.deepEqual(font.body, { fontSize: 15, fontFamily: "Avenir Next" });
  assert.equal(font.body, font.body, "the same object per look, so memos hold");
  assert.equal(lineHeight.body, 18);
  assert.equal(weight.medium, "600");
  assert.equal(radius.chrome, 14);
  assert.equal(layout.rowHeight, 40);
  assert.equal(iconName("plus"), "plus.circle");
  assert.equal(iconName("minus"), "minus");
  files.set("themes/roomy.json", '{ "metrics": ');
  reconcileConfig();
  assert.equal(useBasePalette.getState().palette, first.palette, "an unparseable edit keeps the last good look");
  assert.equal(layout.rowHeight, 40);
  files.set("themes/roomy.json", JSON.stringify({ metrics: { rowHeight: 80, rowGap: 5 } }));
  reconcileConfig();
  assert.equal(layout.rowHeight, 34, "an out-of-range value is reported and Ardia's applies");
  assert.equal(layout.rowGap, 5);
  assert.ok(warnings.some((w) => w.includes("themes/roomy.json: metrics.rowHeight must be a number from 24 to 56")));
  writeConfig({ theme: null });
  reconcileConfig();
  assert.equal(activeLook(), DEFAULT_LOOK);
  assert.equal(useBasePalette.getState().palette, null);
  assert.deepEqual({ font: font.body, radius: radius.chrome, row: layout.rowHeight, line: lineHeight.body, weight: weight.medium }, defaults);
});

test("a theme's sidebarWidth resizes the sidebar when it changes after launch, never at launch, and Reset returns to it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh({ sidebarWidth: 230 });
  writeConfig({ theme: "wide" });
  files.set("themes/wide.json", JSON.stringify({ metrics: { sidebarWidth: 300 } }));
  startConfigFiles(colorRoles);
  assert.equal(S().settings.sidebarWidth, 230, "launch keeps the width you left");
  await elapse(t, 6000);
  files.set("themes/wide.json", JSON.stringify({ metrics: { sidebarWidth: 280 } }));
  reconcileConfig();
  assert.equal(S().settings.sidebarWidth, 280);
  S().updateSettings({ sidebarWidth: 250 });
  reconcileConfig();
  assert.equal(S().settings.sidebarWidth, 250, "an unchanged value leaves a width you dragged alone");
  resetSidebarWidth();
  assert.equal(S().settings.sidebarWidth, 280);
  writeConfig({ theme: null });
  reconcileConfig();
  resetSidebarWidth();
  assert.equal(S().settings.sidebarWidth, 190);
});
