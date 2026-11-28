import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import { lazyComponentId, webShellConfig } from "./vite.shared";
import { inputAdapters, rawBookmarkAdapter, resolveInputAdapter } from "./inputAdapters";
import { desktopMode, type DesktopMode } from "./desktopModes";
import { keyedPaths, pathKey, pathKeys, posixFilePath, toPosixPath } from "./desktopPaths";
import { linuxWordingPlugins } from "./src/platform/linux/wording/plugins";
import { CONTROL_KEY_NAME as LINUX_CONTROL_KEY } from "./src/platform/keyNames.linux";
import { CONTROL_KEY_NAME as WIN_CONTROL_KEY } from "./src/platform/keyNames.win";
import { CONTROL_KEY_NAME as MAC_CONTROL_KEY } from "./src/platform/keyNames.mac";
import { desktopShortcutText, hasMacModifiers } from "./shortcutText";

const here = (path: string) => posixFilePath(new URL(path, import.meta.url));
const replacements = new Map([
  ...inputAdapters,
  [here("../browser/src/platform/livePersistence.ts"), here("./src/livePersistence.ts")],
  [here("../browser/src/platform/fieldTiming.ts"), here("./src/fieldTiming.ts")],
  [here("../browser/src/platform/pickConfirmation.ts"), here("./src/pickConfirmation.ts")],
  [here("../browser/src/platform/sharedFolders.ts"), here("./src/hostSharedFolders.ts")],
  [here("../../packages/core/src/suggestFetcher.ts"), here("./src/suggestFetcher.ts")],
  [here("../browser/src/components/settings/settingsIndex.ts"), here("./src/settingsIndex.ts")],
  [here("../browser/src/components/settings/Form.tsx"), here("./src/settingsForm.tsx")],
  [here("../browser/src/state/engines/engines.ts"), here("./src/hostEngines.ts")],
  [here("../browser/src/components/sidebar/HoverCard.tsx"), here("./src/SidebarHoverCard.tsx")],
  [here("../browser/src/components/site/SelectionPopover.tsx"), here("./src/SelectionPopover.tsx")],
  [here("../browser/src/components/window/PageOverlays.tsx"), here("./src/PageOverlays.tsx")],
  [here("../browser/src/components/window/WindowOverlays.tsx"), here("./src/WindowOverlays.tsx")],
  [here("../browser/src/components/downloads/Downloads.tsx"), here("./src/DownloadsPopover.tsx")],
  [here("../browser/src/state/settings/settingsWindows.ts"), here("./src/settingsWindows.ts")],
  [here("../browser/src/components/profiles/ProfileIndicator.tsx"), here("./src/ProfileIndicator.tsx")],
  [here("../browser/src/components/sidebar/AddressBar.tsx"), here("./src/SidebarAddressBar.tsx")],
  [here("../browser/src/components/sidebar/TileFace.tsx"), here("./src/TileFace.tsx")],
  [here("../browser/src/components/site/SiteConnection.tsx"), here("./src/SiteConnection.tsx")],
  [here("../browser/src/state/settings/paneData.ts"), here("./src/credentialPaneData.ts")],
  [here("../browser/src/components/settings/panes/ProfilePasswords.tsx"), here("./src/LinuxPasswordsPane.tsx")],
  [here("../browser/src/components/settings/panes/ProfileAutofill.tsx"), here("./src/LinuxAutofillPane.tsx")],
  [here("../browser/src/state/import/apply.ts"), here("./src/importApply.ts")],
  [here("../browser/src/components/import/steps/UnlockStep.tsx"), here("./src/LinuxUnlockStep.tsx")],
  [here("../browser/src/state/sync/engine.ts"), here("./src/syncEngine.ts")],
  [here("../browser/src/state/live/sources.ts"), here("./src/liveSources.ts")],
  [here("../browser/src/state/live/net.ts"), here("./src/liveNet.ts")],
  [here("../browser/src/components/extensions/ActionPopup.tsx"), here("./src/ExtensionActionPopup.tsx")],
  [here("../browser/src/platform/windowControls.ts"), here("./src/hostWindowControls.ts")],
  [here("../browser/src/components/window/WindowControls.tsx"), here("./src/WindowControls.tsx")],
  [here("../browser/src/components/window/LeadingWindowControls.tsx"), here("./src/LeadingWindowControls.tsx")],
]);
const importedPasswordSave = {
  source: here("../browser/src/state/site/passwords.ts"),
  importers: new Set([here("../browser/src/components/settings/panes/ProfilePasswords.tsx"), here("../browser/src/state/site/savedPasswords.ts")]),
  replacement: here("./src/importedPasswordSave.ts"),
};
const tabLifecycle = here("../browser/src/state/tabs/tabLifecycle.ts");
const importerReplacements = new Map([
  [`${here("../browser/src/components/sidebar/Sidebar.tsx")}\0${here("../browser/src/components/window/SidebarDock.tsx")}`, here("./src/SidebarPeekMark.tsx")],
  [`${here("../browser/src/components/tabstrip/TopTabStrip.tsx")}\0${here("../browser/src/App.tsx")}`, here("./src/TopStripPeekRegion.tsx")],
  [`${here("../browser/src/components/toolbar/AutoHideToolbar.tsx")}\0${here("../browser/src/components/window/TabPane.tsx")}`, here("./src/AutoHideToolbarRegion.tsx")],
  [`${here("../browser/src/components/toolbar/AutoHideToolbar.tsx")}\0${here("../browser/src/components/toolbar/WindowToolbar.tsx")}`, here("./src/AutoHideToolbarRegion.tsx")],
  [`${here("../browser/src/components/peek/PeekOverlay.tsx")}\0${here("../browser/src/components/window/ContentCard.tsx")}`, here("./src/PeekOverlay.tsx")],
  [`${here("../browser/src/components/split/SplitChrome.tsx")}\0${here("../browser/src/components/window/ContentCard.tsx")}`, here("./src/SplitToastRegion.tsx")],
  [`${here("../browser/src/state/app/toasts.ts")}\0${tabLifecycle}`, here("./src/policyToasts.ts")],
  [`${here("../browser/src/platform/performance.ts")}\0${tabLifecycle}`, here("./src/policyPerformance.ts")],
  [`${here("../browser/src/state/site/webNotifications.ts")}\0${here("../browser/src/state/site/permissions.ts")}`, here("./src/notificationPermission.ts")],
  [`${lazyComponentId(here("../browser/src/components/extensions/ExtensionOverlays.tsx"))}\0${here("../browser/src/components/settings/panes/ProfileExtensions.tsx")}`, here("./src/SettingsInstallDialog.tsx")],
  [`${here("../browser/src/platform/webviews.ts")}\0${here("../browser/src/state/drag/tabDrag.ts")}`, here("./src/dragWebviews.ts")],
  [`${here("../browser/src/platform/extensions.ts")}\0${here("../browser/src/state/extensions/actions.ts")}`, here("./src/extensionInstalls.ts")],
  [`${here("../browser/src/state/report/actions.ts")}\0${here("../browser/src/state/commands/appCommands.ts")}`, here("./src/reportProblem.ts")],
  [`${here("../browser/src/components/ui/Panel.tsx")}\0${here("../browser/src/components/ui/Popover.tsx")}`, here("./src/GlassPanel.tsx")],
  [`${here("../browser/src/components/ui/index.ts")}\0${here("../browser/src/components/window/SidebarDock.tsx")}`, here("./src/glassUi.tsx")],
  [`${here("../browser/src/components/ui/index.ts")}\0${here("../browser/src/App.tsx")}`, here("./src/rootBackdropUi.tsx")],
  [`${here("../browser/src/components/ui/index.ts")}\0${here("../browser/src/components/omnibox/PanelBox.tsx")}`, here("./src/glassUi.tsx")],
  [`${here("../browser/src/state/windows/controls.ts")}\0${here("../browser/src/components/window/WindowControls.tsx")}`, here("./src/captionControls.ts")],
  [`${here("../browser/src/state/app/appMenu.ts")}\0${here("../browser/src/components/window/BrowserWindowControls.tsx")}`, here("./src/clusterAppMenu.ts")],
  [`${here("../browser/src/state/windows/layout.ts")}\0${here("../browser/src/components/sidebar/Sidebar.tsx")}`, here("./src/sidebarHeaderLayout.ts")],
  [`${here("../browser/src/state/windows/layout.ts")}\0${here("../browser/src/components/downloads/Downloads.tsx")}`, here("./src/sidebarHeaderLayout.ts")],
  [`${here("../browser/src/state/windows/layout.ts")}\0${here("../browser/src/components/sidebar/AddressBar.tsx")}`, here("./src/sidebarHeaderLayout.ts")],
  [`${here("../browser/src/state/windows/layout.ts")}\0${here("../browser/src/components/sidebar/SidebarPage.tsx")}`, here("./src/sidebarHeaderLayout.ts")],
  [`${here("../browser/src/components/sidebar/SidebarPages.tsx")}\0${here("../browser/src/components/sidebar/Sidebar.tsx")}`, here("./src/SidebarPagerTrack.tsx")],
  [`${here("../browser/src/state/windows/profilePager.ts")}\0${here("../browser/src/components/sidebar/SidebarPage.tsx")}`, here("./src/sidebarPageStyle.ts")],
  [`${here("../browser/src/components/window/ProfileSwipe.tsx")}\0${here("../browser/src/App.tsx")}`, here("./src/ProfileTintTimeline.tsx")],
]);
const siteMeadow = here("../site/src/scripts/meadow/");
const siteMeadowKey = pathKey(siteMeadow);
const SITE_MEADOW_TSCONFIG = JSON.stringify({ compilerOptions: { target: "ESNext", verbatimModuleSyntax: true, strict: true } });

function siteMeadowScripts(): Plugin {
  return {
    name: "ardia-desktop:site-meadow",
    enforce: "pre",
    async transform(code, rawId) {
      const id = toPosixPath(rawId);
      if (!pathKey(id).startsWith(siteMeadowKey) || !id.endsWith(".ts")) return null;
      const result = await transformWithEsbuild(code, id, { loader: "ts", tsconfigRaw: SITE_MEADOW_TSCONFIG });
      return { code: result.code, map: null };
    },
  };
}

const adapters = pathKeys([...replacements.values(), ...importerReplacements.values(), rawBookmarkAdapter.replacement, importedPasswordSave.replacement]);
const replacementsByKey = keyedPaths(replacements);
const importerReplacementsByKey = keyedPaths(importerReplacements);
const passwordSaveSource = pathKey(importedPasswordSave.source);
const passwordSaveImporters = pathKeys(importedPasswordSave.importers);

const CONTROL_KEYS: Record<DesktopMode, string> = { linux: LINUX_CONTROL_KEY, win: WIN_CONTROL_KEY, mac: MAC_CONTROL_KEY };
const PLATFORM_WORDING: Record<DesktopMode, () => Plugin[]> = { linux: linuxWordingPlugins, win: () => [], mac: () => [] };

function desktopComponents(mode: DesktopMode): Plugin {
  const shortcutText = desktopShortcutText(CONTROL_KEYS[mode]);
  return {
    name: "ardia-desktop:components",
    enforce: "pre",
    transform(code, rawId) {
      const id = toPosixPath(rawId);
      if (!id.includes("/apps/browser/src/components/")) return null;
      if (mode === "mac" || id.endsWith("/settings/searchMatch.ts") || !hasMacModifiers(code)) return null;
      return { code: shortcutText(code), map: null };
    },
    async resolveId(source, rawImporter, options) {
      if (!rawImporter) return null;
      const importer = pathKey(rawImporter);
      if (adapters.has(importer)) return null;
      const resolved = await this.resolve(source, rawImporter, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = pathKey(resolved.id);
      if (id === passwordSaveSource && passwordSaveImporters.has(importer)) return importedPasswordSave.replacement;
      const scoped = importerReplacementsByKey.get(`${id}\0${importer}`);
      if (scoped) return scoped;
      return resolveInputAdapter(id, importer) ?? replacementsByKey.get(id) ?? null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const platform = desktopMode(mode);
  const shell = webShellConfig(platform, {
    plugins: [siteMeadowScripts(), desktopComponents(platform), ...PLATFORM_WORDING[platform]()],
    aliases: [
      { find: /^@ardia\/shell$/, replacement: here("./src/shims/shell.tsx") },
      { find: /^@ardia\/ardiacore$/, replacement: here("./src/shims/ardiacore.tsx") },
      { find: /^@ardia-site\/meadow\/(scene|clock|cycle)$/, replacement: `${siteMeadow}$1.ts` },
    ],
  });
  return { ...shell, esbuild: { exclude: [/\.js$/, /\/apps\/site\/src\/scripts\/meadow\//] } };
});
