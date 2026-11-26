import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "vite";
import { inputAdapters, rawBookmarkAdapter } from "../inputAdapters.ts";
import { posixFilePath } from "../desktopPaths.ts";

const root = posixFilePath(new URL("../", import.meta.url));
const repo = posixFilePath(new URL("../../../", import.meta.url));
const browser = `${repo}apps/browser/src/`;
const desktop = `${root}src/`;

const productions = new Map();
const productionGraph = (mode = "linux") => productions.get(mode) ?? productions.set(mode, (async () => {
  let graph;
  const result = await build({
    root,
    configFile: `${root}vite.config.ts`,
    mode,
    logLevel: "error",
    build: { write: false },
    plugins: [{
      name: "ardia-desktop:test-module-graph",
      generateBundle() {
        graph = new Map([...this.getModuleIds()].map((id) => [id, this.getModuleInfo(id)]));
      },
    }],
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output).filter((entry) => entry.type === "chunk");
  return { graph, ids: [...graph.keys()], chunks };
})()).get(mode);
const only = (ids, id) => ids.filter((candidate) => candidate.split("?")[0] === id);

const ADAPTER_REPLACEMENTS = [
  ["components/sidebar/HoverCard.tsx", "SidebarHoverCard.tsx", ["HoverCard"]],
  ["components/site/SelectionPopover.tsx", "SelectionPopover.tsx", ["SelectionPopover"]],
  ["components/window/PageOverlays.tsx", "PageOverlays.tsx", ["BesidePeekPopovers", "PageOverlays", "PeekPage"]],
  ["components/window/WindowOverlays.tsx", "WindowOverlays.tsx", ["windowOverlays"]],
  ["components/downloads/Downloads.tsx", "DownloadsPopover.tsx", ["DownloadMagnet", "DownloadsPopover"]],
  ["components/profiles/ProfileIndicator.tsx", "ProfileIndicator.tsx", ["HeaderAppMenu", "profileIndicatorX", "ProfileIndicator", "useAppMenuInHeader", "useProfileIndicatorWidth"]],
  ["components/sidebar/AddressBar.tsx", "SidebarAddressBar.tsx", ["SidebarAddressRow", "SidebarHeaderTools"]],
  ["components/sidebar/TileFace.tsx", "TileFace.tsx", ["FolderDropRing", "RestingTile", "TileFace", "useSlotPosition"]],
  ["state/settings/settingsWindows.ts", "settingsWindows.ts", ["goToSettingsPane", "openImport", "openSettings", "useSettingsNav"]],
  ["components/settings/settingsIndex.ts", "settingsIndex.ts", ["PANES", "SETTINGS_INDEX", "findSetting", "setting", "settingUnavailable"]],
  ["components/settings/Form.tsx", "settingsForm.tsx", ["Anchor", "Group", "Row", "SectionHeader", "SettingsPaneContext"]],
  ["state/engines/engines.ts", "hostEngines.ts", ["canSwitchEngine", "chosenEngine", "defaultEngine", "offersEngineChoice", "tabEngine", "siteOf"]],
  ["state/import/apply.ts", "importApply.ts", ["applyResult", "applySafari", "emptyCounts", "importBookmarks"]],
  ["platform/sharedFolders.ts", "hostSharedFolders.ts", ["revealSharedFolder", "sharedFoldersAvailable", "readSharedFolder", "watchSharedFolders"]],
];

function assertAdapterReplacements(graph, ids) {
  for (const [shared, adapter, names] of ADAPTER_REPLACEMENTS) {
    const id = `${desktop}${adapter}`;
    const original = `${browser}${shared}`;
    assert.deepEqual(only(ids, id), [id], adapter);
    for (const name of names) {
      const exports = graph.get(id)?.exports ?? [];
      assert.ok(exports.includes(name) || exports.includes("*") && graph.get(original)?.exports.includes(name), `${adapter}: ${name}`);
    }
    assert.deepEqual(graph.get(original)?.importers, [id], `${shared} is only loaded by its adapter`);
    assert.ok(graph.get(id).importedIds.includes(original));
  }
}

test("production graph uses current Linux adapters and one canonical shared state and native module graph", { timeout: 120000 }, async () => {
  const { graph, ids, chunks } = await productionGraph();
  assert.ok(graph?.size > 1000);
  assert.deepEqual(ids.filter((id) => id.includes("/packages/demo/")), []);
  assert.deepEqual(ids.filter((id) => /\/apps\/browser\/src\/(store\/|lib\/(native|tabPages|preload|theme)\.)/.test(id)), []);

  const singletons = [
    `${browser}state/browser/store.ts`,
    `${browser}state/settings/settingsWindows.ts`,
    `${browser}state/tabs/prewarm.ts`,
    `${desktop}settingsWindows.ts`,
    `${desktop}menus.tsx`,
    `${desktop}host.ts`,
    `${desktop}shims/expo-modules-core.ts`,
    `${desktop}shims/ardiacore.tsx`,
    `${desktop}shims/shell.tsx`,
    `${desktop}shims/web/HostWebView.tsx`,
    `${desktop}shims/web/Symbol.tsx`,
    `${desktop}shims/web/symbols/render.ts`,
  ];
  for (const id of singletons) assert.deepEqual(only(ids, id), [id], id);

  assertAdapterReplacements(graph, ids);

  const permissions = graph.get(`${browser}state/site/permissions.ts`);
  assert.ok(permissions.importedIds.includes(`${desktop}notificationPermission.ts`), "accepting a notification prompt goes through the Linux permission adapter");
  assert.ok(!permissions.importedIds.includes(`${browser}state/site/webNotifications.ts`));
  assert.ok(graph.get(`${desktop}notificationPermission.ts`).importedIds.includes(`${browser}state/site/webNotifications.ts`));

  const csvImport = graph.get(`${browser}state/site/savedPasswords.ts`);
  assert.ok(csvImport.importedIds.includes(`${desktop}importedPasswordSave.ts`), "Settings › Passwords › Import saves CSV passwords through the Linux import-handle adapter");
  assert.ok(!csvImport.importedIds.includes(`${browser}state/site/passwords.ts`));
  assert.ok(graph.get(`${desktop}importedPasswordSave.ts`).importedIds.includes(`${browser}state/site/passwords.ts`));

  const dock = graph.get(`${browser}components/window/SidebarDock.tsx`);
  assert.ok(dock.importedIds.includes(`${desktop}SidebarPeekMark.tsx`), "the docked sidebar marks a peek for the page viewport");
  assert.ok(!dock.importedIds.includes(`${browser}components/sidebar/Sidebar.tsx`));
  assert.ok(graph.get(`${desktop}SidebarPeekMark.tsx`).importedIds.includes(`${browser}components/sidebar/Sidebar.tsx`));

  const app = graph.get(`${browser}App.tsx`);
  assert.ok(app.importedIds.includes(`${desktop}TopStripPeekRegion.tsx`), "the top strip's peek reserves its input region over the page");
  assert.ok(!app.importedIds.includes(`${browser}components/tabstrip/TopTabStrip.tsx`));
  assert.ok(graph.get(`${desktop}TopStripPeekRegion.tsx`).importedIds.includes(`${browser}components/tabstrip/TopTabStrip.tsx`));

  const sidebar = graph.get(`${browser}components/sidebar/Sidebar.tsx`);
  assert.ok(sidebar.importedIds.includes(`${desktop}SidebarPagerTrack.tsx`), "the sidebar pages through the bounded compositor track");
  assert.ok(!sidebar.importedIds.includes(`${browser}components/sidebar/SidebarPages.tsx`));
  const sidebarPage = graph.get(`${browser}components/sidebar/SidebarPage.tsx`);
  assert.ok(sidebarPage.importedIds.includes(`${desktop}sidebarPageStyle.ts`), "sidebar pages sit still on the track and the track scrolls");
  assert.ok(!sidebarPage.importedIds.includes(`${browser}state/windows/profilePager.ts`));
  assert.ok(graph.get(`${browser}components/tabstrip/StripPage.tsx`).importedIds.includes(`${browser}state/windows/profilePager.ts`), "the top strip keeps its own page transforms");
  assert.ok(app.importedIds.includes(`${desktop}ProfileTintTimeline.tsx`), "the window tint follows the track's ScrollTimeline");
  assert.ok(!app.importedIds.includes(`${browser}components/window/ProfileSwipe.tsx`));
  assert.ok(graph.get(`${browser}components/window/SidebarDock.tsx`).importedIds.includes(`${browser}components/window/ProfileSwipe.tsx`), "the sidebar keeps the shared swipe area");

  for (const importer of ["components/window/TabPane.tsx", "components/toolbar/WindowToolbar.tsx"]) {
    const toolbarHost = graph.get(`${browser}${importer}`);
    assert.ok(toolbarHost.importedIds.includes(`${desktop}AutoHideToolbarRegion.tsx`), `${importer}: the auto-hide toolbar reserves its input region over the page, so a peek keeps the page shown`);
    assert.ok(!toolbarHost.importedIds.includes(`${browser}components/toolbar/AutoHideToolbar.tsx`));
  }
  assert.deepEqual(graph.get(`${browser}components/toolbar/AutoHideToolbar.tsx`).importers, [`${desktop}AutoHideToolbarRegion.tsx`], "the shared auto-hide toolbar is reached only through the Linux region");

  const card = graph.get(`${browser}components/window/ContentCard.tsx`);
  assert.ok(card.importedIds.includes(`${desktop}SplitToastRegion.tsx`), "toasts reserve their input region over the page, so their buttons take the click");
  assert.ok(!card.importedIds.includes(`${browser}components/split/SplitChrome.tsx`));

  assert.ok(graph.has(`${browser}lib/captionChrome.ts`) && !graph.has(`${browser}lib/platformChrome.windows.ts`), "Linux lays out its window like the Windows build, from the shared caption chrome");
  assert.ok(!graph.has(`${browser}platform/windowControls.ts`) && !graph.has(`${browser}platform/windowControls.windows.ts`), "window buttons reach the Linux host, not a native Windows module");
  assert.ok(graph.get(`${browser}state/windows/controls.ts`).importedIds.includes(`${desktop}hostWindowControls.ts`));
  const sharedControls = graph.get(`${browser}components/window/WindowControls.tsx`);
  assert.deepEqual(sharedControls.importers, [`${desktop}WindowControls.tsx`], "the shared window buttons are reached only through the Linux wrapper");
  assert.ok(sharedControls.importedIds.includes(`${desktop}captionControls.ts`) && !sharedControls.importedIds.includes(`${browser}state/windows/controls.ts`), "Close goes to the Linux close coordinator once");
  assert.ok(!graph.has(`${browser}components/window/LeadingWindowControls.tsx`), "the left group is Linux's own, drawn where the traffic lights would be");
  for (const host of ["components/window/BrowserWindowControls.tsx", "components/settings/SettingsWindow.tsx", "components/import/ImportWindow.tsx"]) {
    assert.ok(graph.get(`${browser}${host}`).importedIds.includes(`${desktop}LeadingWindowControls.tsx`), `${host} draws the desktop's left buttons`);
  }
  assert.ok(graph.get(`${desktop}LeadingWindowControls.tsx`).importedIds.includes(`${desktop}WindowControls.tsx`), "the left group goes through the same Linux wrapper as the right one");
  assert.ok(graph.get(`${desktop}shellEntry.tsx`).importedIds.includes(`${desktop}platform/buttonLayout.linux.ts`), "every window follows the desktop's button layout");
  assert.ok(graph.get(`${desktop}platform/buttonLayout.linux.ts`).importedIds.includes(`${desktop}platform/linux/desktopButtonLayout.ts`), "the button layout comes from GTK's setting on Linux");
  const controls = graph.get(`${browser}components/window/BrowserWindowControls.tsx`).importedIds;
  assert.ok(controls.includes(`${desktop}clusterAppMenu.ts`) && !controls.includes(`${browser}state/app/appMenu.ts`), "the … beside the window buttons opens Linux's full app menu");
  for (const importer of ["components/sidebar/Sidebar.tsx", "components/downloads/Downloads.tsx", "components/sidebar/AddressBar.tsx"]) {
    const imported = graph.get(`${browser}${importer}`).importedIds;
    assert.ok(imported.includes(`${desktop}sidebarHeaderLayout.ts`) && !imported.includes(`${browser}state/windows/layout.ts`), `${importer} keeps the header, and its menu, whenever the window buttons are hidden`);
  }
  assert.ok(graph.get(`${desktop}shellEntry.tsx`).importedIds.includes(`${desktop}TrafficLights.tsx`), "Linux draws its own traffic lights when they are chosen");
  assert.ok(graph.get(`${desktop}TrafficLights.tsx`).importedIds.includes(`${desktop}captionControls.ts`), "the traffic lights close, minimize and maximize through the same adapters as the native buttons");

  for (const [twin, suffix] of [["lib/platformFeatures", "linux"], ["lib/platformTerms", "linux"], ["lib/platformChrome", "desktop"], ["state/commands/comboWords", "desktop"], ["state/tabs/engineKeptCodes", "desktop"], ["lib/pageStacking", "desktop"]]) {
    assert.ok(graph.has(`${browser}${twin}.${suffix}.ts`), `${twin} resolves to its .${suffix} twin`);
    assert.ok(!graph.has(`${browser}${twin}.ts`), `the macOS ${twin} stays out of the Linux bundle`);
  }
  assert.ok(graph.get(`${browser}state/onboarding/presets.ts`).importedIds.includes(`${browser}lib/platformFeatures.linux.ts`), "onboarding's classic-browser presets read Linux's features, so they leave the tab layout to the sidebar default");
  assert.ok(!graph.has(`${browser}platform/fieldTiming.ts`), "the macOS-only field timing module stays out of the Linux bundle");
  assert.ok(graph.get(`${browser}state/telemetry/journeys.ts`).importedIds.includes(`${desktop}fieldTiming.ts`), "journeys reads the Linux field timing stub");
  for (const shared of ["state/live/sources.ts", "state/live/net.ts"]) assert.ok(!graph.has(`${browser}${shared}`), `${shared} and its renderer fetch stay out of the Linux bundle`);
  const liveImporters = [
    [`${browser}state/live/engine.ts`, `${desktop}liveSources.ts`],
    [`${browser}state/live/googleAuth.ts`, `${desktop}liveSources.ts`],
    [`${browser}state/live/googleAuth.ts`, `${desktop}liveNet.ts`],
    [`${browser}components/settings/panes/LiveFoldersSection.tsx`, `${desktop}liveSources.ts`],
    [`${browser}components/settings/panes/LiveFoldersSection.tsx`, `${desktop}liveNet.ts`],
    [`${browser}components/settings/panes/ConnectAccountSheet.tsx`, `${desktop}liveSources.ts`],
    [`${desktop}liveSources.ts`, `${desktop}hostLive.ts`],
  ];
  for (const [importer, adapter] of liveImporters) assert.ok(graph.get(importer)?.importedIds.includes(adapter), `${importer} uses ${adapter}`);
  assert.deepEqual(ids.filter((id) => id.split("?")[0] === `${browser}components/import/steps/UnlockStep.tsx`), []);
  assert.deepEqual(ids.filter((id) => id.split("?")[0] === `${desktop}LinuxUnlockStep.tsx`), [`${desktop}LinuxUnlockStep.tsx`]);
  assert.deepEqual(graph.get(`${desktop}LinuxUnlockStep.tsx`)?.importers, [`${browser}components/import/ImportWindow.tsx`]);

  const syncDevice = [
    [`${browser}state/sync/scopeAdapters.ts`, `${browser}platform/sync.ts`],
    [`${browser}platform/sync.ts`, `${desktop}shims/sync.tsx`],
    [`${repo}packages/sync/src/native.ts`, `${desktop}shims/expo-modules-core.ts`],
  ];
  for (const [importer, imported] of syncDevice) assert.ok(graph.get(importer)?.importedIds.includes(imported), `the sync device name reaches the Linux host: ${importer} imports ${imported}`);

  const coreSuggestFetcher = `${repo}packages/core/src/suggestFetcher.ts`;
  assert.deepEqual(graph.get(coreSuggestFetcher)?.importers, [`${desktop}suggestFetcher.ts`]);
  assert.ok(graph.get(`${desktop}suggestFetcher.ts`).importedIds.includes(`${desktop}hostSuggestions.ts`));

  const lazyModules = [
    ["settings/UtilityWindow", ["UtilityWindow"]],
    ["onboarding/OnboardingOverlay", ["OnboardingOverlay"]],
    ["pages/InternalPage", ["InternalPage"]],
    ["extensions/ExtensionOverlays", ["ExtensionOverlays", "InstallDialogHost"]],
    ["extensions/SidePanel", ["ExtensionSidePanel"]],
    ["bookmarks/BookmarkDialog", ["BookmarkDialog"]],
    ["bookmarks/EditBookmarkDialog", ["EditBookmarkDialog"]],
    ["littleArdia/LittleArdiaWindow", ["LittleArdiaWindow"]],
  ];
  for (const [feature, names] of lazyModules) {
    const original = `${browser}components/${feature}.tsx`;
    const wrapper = `\0ardia-lazy:${original}`;
    const eager = `${original}?ardia-eager`;
    assert.ok(graph.has(wrapper), feature);
    assert.ok(graph.has(eager), feature);
    assert.ok(!graph.has(original), `${feature} has no second eager instance`);
    assert.deepEqual(graph.get(wrapper).exports.toSorted(), names.toSorted());
    for (const name of names) assert.ok(graph.get(eager).exports.includes(name), `${feature}: ${name}`);
    assert.deepEqual(graph.get(wrapper).dynamicallyImportedIds, [eager]);
  }

  const extensionsPane = graph.get(`${browser}components/settings/panes/ProfileExtensions.tsx`);
  const lazyOverlays = `\0ardia-lazy:${browser}components/extensions/ExtensionOverlays.tsx`;
  assert.ok(extensionsPane.importedIds.includes(`${desktop}SettingsInstallDialog.tsx`), "the Extensions pane hosts its install dialog through the Linux host");
  assert.ok(!extensionsPane.importedIds.includes(lazyOverlays));
  assert.deepEqual(graph.get(`${desktop}SettingsInstallDialog.tsx`)?.importers, [`${browser}components/settings/panes/ProfileExtensions.tsx`]);
  assert.ok(graph.get(`${desktop}SettingsInstallDialog.tsx`).importedIds.includes(lazyOverlays));
  assert.ok(graph.get(`${desktop}SettingsInstallDialog.tsx`).importedIds.includes(`${desktop}installRequestSheet.ts`));

  const extensionActions = graph.get(`${browser}state/extensions/actions.ts`);
  assert.ok(extensionActions.importedIds.includes(`${desktop}extensionInstalls.ts`), "an unpacked install's failure is tied back to its request through the Linux install adapter");
  assert.ok(!extensionActions.importedIds.includes(`${browser}platform/extensions.ts`));
  assert.ok(graph.get(`${desktop}extensionInstalls.ts`).importedIds.includes(`${browser}platform/extensions.ts`));

  const tabDrag = graph.get(`${browser}state/drag/tabDrag.ts`);
  assert.ok(tabDrag.importedIds.includes(`${desktop}dragWebviews.ts`), "a tab drag reaches page pictures through the Linux drag preview gate");
  assert.ok(!tabDrag.importedIds.includes(`${browser}platform/webviews.ts`));

  const appCommands = graph.get(`${browser}state/commands/appCommands.ts`);
  assert.ok(appCommands.importedIds.includes(`${desktop}reportProblem.ts`), "Report a Problem from any shared path reaches the Linux entry, which opens the sheet or the issue page");
  assert.ok(!appCommands.importedIds.includes(`${browser}state/report/actions.ts`));

  const passwordsPane = graph.get(`${browser}components/settings/panes/ProfilePasswords.tsx`);
  assert.ok(passwordsPane.importedIds.includes(`${desktop}importedPasswordSave.ts`), "the Passwords pane saves imported handles through the Linux adapter");
  assert.ok(!passwordsPane.importedIds.includes(`${browser}state/site/passwords.ts`));

  for (const id of singletons) assert.equal(chunks.filter((chunk) => id in chunk.modules).length, 1, id);
  assert.ok(graph.get(`${desktop}shellEntry.tsx`).importedIds.includes(`${browser}state/browser/store.ts`));
  assert.ok(graph.get(`${desktop}shellEntry.tsx`).importedIds.includes(`${browser}state/tabs/prewarm.ts`));
});

test("production graph selects canonical Live persistence and one shared Live store", { timeout: 120000 }, async () => {
  const { graph, ids, chunks } = await productionGraph();
  const store = `${browser}state/live/store.ts`;
  const binding = `${desktop}livePersistence.ts`;
  const defaultBinding = `${browser}platform/livePersistence.ts`;
  assert.deepEqual(only(ids, store), [store]);
  assert.deepEqual(only(ids, binding), [binding]);
  assert.equal(graph.has(defaultBinding), false);
  assert.ok(graph.get(store).importedIds.includes(binding));
  for (const id of [store, binding]) assert.equal(chunks.filter((chunk) => id in chunk.modules).length, 1, id);
  assert.equal(chunks.some((chunk) => defaultBinding in chunk.modules), false);
});

test("production graph routes command state, Settings, sidebar, top tabs and bookmarks through the Linux input boundaries", { timeout: 120000 }, async () => {
  const { graph, ids } = await productionGraph();
  for (const [original, adapter] of inputAdapters) {
    assert.ok(graph.has(adapter), adapter);
    if (adapter.endsWith("clickModifiers.ts")) assert.ok(!graph.has(original), original);
    else {
      assert.ok(graph.get(adapter).importedIds.includes(original), adapter);
      for (const importer of graph.get(original).importers) assert.ok([...inputAdapters.values()].includes(importer), `${original} bypassed by ${importer}`);
    }
    assert.deepEqual(only(ids, adapter), [adapter]);
  }
  const routes = [
    [`${browser}state/commands/commandShortcuts.ts`, "commandCatalog.ts"],
    [`${browser}state/commands/commandShortcuts.ts`, "shortcutFormat.ts"],
    [`${browser}state/settings/paneData.ts`, "shortcutCommands.ts"],
    [`${browser}state/settings/paneData.ts`, "shortcutState.ts"],
    [`${browser}components/settings/panes/Shortcuts.tsx`, "shortcutFormat.ts"],
    [`${browser}components/bookmarks/BarItem.tsx`, "rawBookmarkActions.ts"],
    [`${browser}components/pages/HistoryRow.tsx`, "rawBookmarkActions.ts"],
    [`${desktop}menus.tsx`, "shortcutFormat.ts"],
    [`${desktop}menus.tsx`, "clickModifiers.ts"],
  ];
  for (const [consumer, adapter] of routes) assert.ok(graph.get(consumer)?.importedIds.includes(`${desktop}${adapter}`), consumer);
  assert.ok(graph.get(rawBookmarkAdapter.replacement).importedIds.includes(rawBookmarkAdapter.source));
  assert.deepEqual(graph.get(rawBookmarkAdapter.replacement).importers.toSorted(), [...rawBookmarkAdapter.importers].toSorted());
  for (const consumer of ["components/window/HistoryPopover.tsx", "components/toolbar/NavButtons.tsx", "state/site/selection.ts"]) {
    assert.ok(graph.get(`${browser}${consumer}`).importedIds.includes(rawBookmarkAdapter.source), consumer);
    assert.ok(!graph.get(`${browser}${consumer}`).importedIds.includes(rawBookmarkAdapter.replacement), consumer);
  }
});

const siteConnection = `${browser}components/site/SiteConnection.tsx`;
const siteConnectionAdapter = `${desktop}SiteConnection.tsx`;

test("production SiteConnection replacement reaches the real SiteControls and the WebView shim never reaches shared page state", { timeout: 120000 }, async () => {
  const { graph } = await productionGraph();
  assert.deepEqual(graph.get(siteConnection).importers, [siteConnectionAdapter]);
  assert.ok(graph.get(siteConnectionAdapter).importedIds.includes(siteConnection));
  assert.ok(graph.get(`${browser}components/site/SiteControls.tsx`).importedIds.includes(siteConnectionAdapter));
  const webView = `${desktop}shims/ardiacore.tsx`;
  const seen = new Set([webView]);
  for (const queue = [webView]; queue.length;) for (const next of graph.get(queue.shift())?.importedIds ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  assert.ok(!seen.has(`${browser}state/tabs/pageState.ts`));
});

test("the Linux connection wrapper renders unknown honestly and delegates every known state and certificate details", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ardia-site-connection-"));
  const entry = `${root}scripts/.page-state-entry-${process.pid}.tsx`;
  try {
    await writeFile(entry, `import ${JSON.stringify(`${browser}state/browser/store.ts`)};\nimport {createElement} from "react";\nimport {renderToStaticMarkup} from "react-dom/server";\nimport * as linux from ${JSON.stringify(siteConnectionAdapter)};\nimport * as shared from ${JSON.stringify(siteConnection)};\nexport {linux,shared};\nexport const render=(kind,security)=>renderToStaticMarkup(createElement(linux[kind],{security,open:false,onPress:()=>{}}));\n`);
    await build({ root, configFile: `${root}vite.config.ts`, mode: "linux", logLevel: "error", ssr: { noExternal: true }, build: { ssr: entry, outDir: directory, emptyOutDir: false, minify: false, rollupOptions: { output: { entryFileNames: "fixture.mjs" } } } });
    const fixture = await import(pathToFileURL(join(directory, "fixture.mjs")).href);
    assert.equal(fixture.linux.CertificateDetails, fixture.shared.CertificateDetails);
    for (const security of [null, { level: "none", url: "https://unknown.test", origin: null }]) {
      for (const kind of ["ConnectionChip", "ConnectionRow"]) {
        const html = fixture.render(kind, security);
        assert.match(html, /Connection information unavailable/);
        assert.doesNotMatch(html, /Local Page|local or internal/);
      }
    }
    for (const [level, label] of [["secure", "Secure"], ["local", "Local Page"], ["mixed", "Not Fully Secure"], ["insecure", "Not Secure"], ["certificateError", "Not Secure"]]) {
      const html = fixture.render("ConnectionChip", { level, url: "https://test", origin: "https://test" });
      assert.match(html, new RegExp(label));
      assert.doesNotMatch(html, /information unavailable/);
    }
  } finally {
    await rm(entry, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux shell exports and shared package Expo dialogs use one adapter", () => {
  const script = fileURLToPath(new URL("./dialog-module-production.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /share the production adapter/);
});

const LIQUID_GLASS = ["engine.ts", "dom-snapshot.ts"].map((file) => `${repo}third_party/liquid-glass/${file}`);

test("every desktop build draws glass with the one vendored Liquid Glass engine, through the layer the demo shares byte for byte", { timeout: 120000 }, async () => {
  for (const file of ["liquidGlass.tsx", "liquidGlassOptics.ts", "liquidGlassPlace.ts"]) assert.equal(readFileSync(`${desktop}shims/web/${file}`, "utf8"), readFileSync(`${repo}packages/demo/src/shims/web/${file}`, "utf8"), `the desktop and demo ${file} drifted apart`);
  for (const mode of ["linux", "win", "mac"]) {
    const { graph, ids } = await productionGraph(mode);
    for (const id of LIQUID_GLASS) assert.deepEqual(only(ids, id), [id], `${mode}: ${id}`);
    assert.ok(graph.get(`${desktop}shims/web/chrome.tsx`)?.importedIds.includes(`${desktop}shims/web/liquidGlass.tsx`), `${mode}: GlassEffect draws through the shared layer`);
  }
});

const WIN_TWINS = [
  ["lib/platformTerms", "win"],
  ["lib/platformFeatures", "win"],
  ["lib/platformChrome", "desktop"],
  ["state/commands/comboWords", "desktop"],
  ["state/commands/keyText", "win"],
  ["state/telemetry/copyWords", "win"],
  ["platform/windowsUpdateCounts", "win"],
  ["state/tabs/engineKeptCodes", "desktop"],
  ["lib/pageStacking", "desktop"],
];
const WINDOWS_WORDING = new Set([`${browser}lib/platformTerms.windows.ts`, `${browser}lib/platformChrome.windows.ts`, `${browser}state/telemetry/copyWords.windows.ts`]);
const linuxOnly = (id) => id.startsWith(`${desktop}platform/linux/`) || /\/src\/platform\/[^/]+\.linux\.tsx?$/.test(id) || /\/apps\/browser\/src\/.+\.linux\.tsx?$/.test(id);

test("the win build shares every desktop adapter, takes Windows terms, and leaves Linux-only modules and wording out", { timeout: 120000 }, async () => {
  const { graph, ids, chunks } = await productionGraph("win");
  assert.ok(graph?.size > 1000);
  assert.deepEqual(ids.filter((id) => id.includes("/packages/demo/")), []);
  assertAdapterReplacements(graph, ids);
  for (const [twin, suffix] of WIN_TWINS) {
    assert.ok(graph.has(`${browser}${twin}.${suffix}.ts`), `${twin} resolves to its .${suffix} twin`);
    assert.ok(!graph.has(`${browser}${twin}.ts`) && !graph.has(`${browser}${twin}.linux.ts`), `the macOS and Linux ${twin} stay out of the win bundle`);
  }
  assert.deepEqual(ids.filter(linuxOnly), [], "no Linux-only module reaches the win bundle");
  assert.deepEqual(ids.filter((id) => /\.windows\.tsx?$/.test(id) && !WINDOWS_WORDING.has(id)), [], "only Windows wording comes from the React Native Windows twins");
  const seams = [
    ["shellEntry.tsx", "platform/buttonLayout.win.ts"],
    ["shellEntry.tsx", "platform/launchNotice.desktop.ts"],
    ["shellEntry.tsx", "platform/updater.win.ts"],
    ["AppMenuButton.tsx", "platform/updater.win.ts"],
    ["hostModules.ts", "platform/calendar.desktop.ts"],
    ["hostSystem.ts", "platform/updates.win.ts"],
    ["settingsIndex.ts", "platform/updates.win.ts"],
    ["shortcutFormat.ts", "platform/keyNames.win.ts"],
    ["credentialNotices.ts", "platform/secretWording.win.ts"],
    ["syncKeyStore.ts", "platform/secretWording.win.ts"],
    ["appMenuPlacement.ts", "platform/appMenuButton.desktop.ts"],
  ];
  for (const [importer, seam] of seams) assert.ok(graph.get(`${desktop}${importer}`)?.importedIds.includes(`${desktop}${seam}`), `${importer} imports ${seam}`);
  assert.ok(graph.get(`${desktop}platform/win/hostUpdates.ts`)?.importedIds.includes(`${browser}platform/windowsUpdateCounts.win.ts`), "the Windows updater counts manifest checks in the same twin the hourly telemetry takes them from");
  const code = chunks.map((chunk) => chunk.code).join("\n");
  for (const linux of ["Evolution Data Server", "yay -Syu", "Super+", "(polkit)", "Ardia is running without Chromium's sandbox", '"hyprland","sway","niri"']) assert.ok(!code.includes(linux), `the win bundle says ${linux}`);
  for (const windows of ["File Explorer", "Windows Hello or your Windows password"]) assert.ok(code.includes(windows), `the win bundle lacks ${windows}`);
});

test("the linux build keeps every Windows twin out", { timeout: 120000 }, async () => {
  const { ids } = await productionGraph("linux");
  assert.deepEqual(ids.filter((id) => id.startsWith(`${desktop}platform/win/`) || /\.win\.tsx?$/.test(id)), []);
  assert.deepEqual(ids.filter((id) => /\.windows\.tsx?$/.test(id)), []);
});

const MAC_TWINS = [
  ["lib/platformTerms", ""],
  ["lib/platformFeatures", ""],
  ["state/commands/keyText", ""],
  ["state/telemetry/copyWords", ""],
  ["lib/platformChrome", ".mac"],
  ["state/commands/comboWords", ".desktop"],
  ["state/tabs/engineKeptCodes", ".desktop"],
];
const winOnly = (id) => id.startsWith(`${desktop}platform/win/`) || /\.(win|windows)\.tsx?$/.test(id);
const reactNativeNative = (id) => /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?react-native(-macos|-windows)?\//.test(id) || /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?expo-modules-core\//.test(id);

test("the mac build shares every desktop adapter, takes the Mac's own terms, and leaves Linux, Windows and React Native out", { timeout: 120000 }, async () => {
  const { graph, ids, chunks } = await productionGraph("mac");
  assert.ok(graph?.size > 1000);
  assert.deepEqual(ids.filter((id) => id.includes("/packages/demo/")), []);
  assertAdapterReplacements(graph, ids);
  for (const [twin, suffix] of MAC_TWINS) {
    assert.ok(graph.has(`${browser}${twin}${suffix}.ts`), `${twin} resolves to ${twin}${suffix}.ts`);
    for (const other of [".linux", ".win"]) assert.ok(!graph.has(`${browser}${twin}${other}.ts`), `the ${other} ${twin} stays out of the mac bundle`);
  }
  assert.deepEqual(ids.filter(linuxOnly), [], "no Linux-only module reaches the mac bundle");
  assert.deepEqual(ids.filter(winOnly), [], "no Windows-only module, .win or .windows, reaches the mac bundle");
  assert.ok(graph.has(`${browser}lib/captionChrome.ts`), "the desktop chrome takes its caption sizes from the shared module, not the Windows twin");
  assert.deepEqual(ids.filter(reactNativeNative), [], "React Native and Expo's native modules stay out of the mac WebUI bundle");
  const seams = [
    ["shellEntry.tsx", "platform/buttonLayout.mac.ts"],
    ["shellEntry.tsx", "platform/launchNotice.desktop.ts"],
    ["shellEntry.tsx", "platform/updater.desktop.ts"],
    ["hostModules.ts", "platform/calendar.desktop.ts"],
    ["hostSystem.ts", "platform/updates.desktop.ts"],
    ["shortcutFormat.ts", "platform/keyNames.mac.ts"],
    ["credentialNotices.ts", "platform/secretWording.mac.ts"],
    ["syncKeyStore.ts", "platform/secretWording.mac.ts"],
    ["hostImport.ts", "platform/importWording.mac.ts"],
    ["shims/shaders.tsx", "platform/windowGlass.mac.ts"],
    ["appMenuPlacement.ts", "platform/appMenuButton.mac.ts"],
  ];
  for (const [importer, seam] of seams) assert.ok(graph.get(`${desktop}${importer}`)?.importedIds.includes(`${desktop}${seam}`), `${importer} imports ${seam}`);
  assert.ok(graph.get(`${desktop}platform/windowGlass.mac.ts`).importedIds.includes(`${desktop}platform/mac/macGlass.ts`), "vibrancy backdrops ask the Mac host for glass behind the window");
  const staticClosure = (start) => {
    const seen = new Set([start]);
    for (const id of seen) for (const next of graph.get(id)?.importedIds ?? []) seen.add(next);
    return seen;
  };
  const entry = graph.get(`${desktop}main.tsx`);
  assert.ok(entry.dynamicallyImportedIds.includes(`${desktop}popoverEntry.tsx`) && entry.dynamicallyImportedIds.includes(`${desktop}shellEntry.tsx`), "the entry picks the popover renderer or the browser shell before loading either");
  const shellModules = [`${browser}state/browser/store.ts`, `${desktop}shellEntry.tsx`, `${desktop}shims/expo-modules-core.ts`, `${desktop}shims/shellBase.tsx`, `${browser}App.tsx`];
  for (const start of [`${desktop}main.tsx`, `${desktop}popoverEntry.tsx`]) {
    const closure = staticClosure(start);
    for (const shell of shellModules) assert.ok(!closure.has(shell), `${start} statically pulls in ${shell}`);
  }
  const code = chunks.map((chunk) => chunk.code).join("\n");
  for (const other of ["Evolution Data Server", "yay -Syu", "(polkit)", "Super+", "File Explorer", "Windows Hello"]) assert.ok(!code.includes(other), `the mac bundle says ${other}`);
  for (const mac of ["shell.backdropRegions", "Finder", "Touch ID or your login password", "ArdiaShell.setMainMenu", "shell.glassBehindWindow"]) assert.ok(code.includes(mac), `the mac bundle lacks ${mac}`);
});

test("the linux and win builds keep the Mac twins and Mac glass out", { timeout: 120000 }, async () => {
  for (const mode of ["linux", "win"]) {
    const { ids, chunks } = await productionGraph(mode);
    assert.deepEqual(ids.filter((id) => id.startsWith(`${desktop}platform/mac/`) || /\.mac\.tsx?$/.test(id)), [], `${mode} has a Mac twin`);
    assert.ok(ids.includes(`${desktop}platform/windowGlass.desktop.ts`), `${mode} takes the no-op window glass`);
    assert.ok(!chunks.some((chunk) => chunk.code.includes("shell.backdropRegions")), `${mode} asks for Mac backdrop glass`);
  }
});
