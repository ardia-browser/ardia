import { pluginsFolder, revealPluginLog, revealPluginsFolder } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { turnOffPlugin } from "./lifecycle";
import { consentNow } from "../telemetry/choice";

export { dismissPluginConsent, enablePlugin, removePlugin, requestPluginConsent, setPluginValue, turnOnApprovedPlugin } from "./lifecycle";
export { UNSAVED } from "./store";
export const disablePlugin = (name: string) => turnOffPlugin(name, consentNow());
export { restartProcess as restartPlugin } from "./process";
export { removePluginAfterConfirm } from "./removeConfirmed";
export { openPluginPage, pluginPagePath } from "./pages";
export { consentLines, type ConsentLine } from "./consent";
export { canRelink, relinkPrograms } from "./programs";
export { cancelOfficialInstall, installOfficialPlugin, officialPlugins, COMING_SOON, OFFICIAL_CATALOGUE, type OfficialPlugin, type OfficialPluginState } from "./official";
export type { InstallResult } from "./installWaiters";
export { ensurePluginActivated, PluginActivationError } from "./activation";
export { runPluginCommand, runPluginAction, pluginBarActions } from "./commands";
export { openPluginPanel, closePluginPanel } from "./panels";
export { runPluginToolbarItem, pluginToolbarItems, type PluginToolbarEntry } from "./toolbar";
export { pluginMenuItems, runPluginMenuChoice, isPluginMenuChoice, type PluginMenuContext } from "./menus";
export { pluginThemes, loadPluginTheme, pluginThemeKey, parsePluginThemeKey, type PluginTheme } from "./themes";
export { runPluginDecideHook, type PluginVerdict } from "./decideHooks";
export { setPluginSecretRow, pluginSecretRowIsSet } from "./secretRows";
export {
  mountPluginSurface,
  unmountPluginSurface,
  dispatchPluginSurfaceEvent,
  openPluginSidePanel,
  closePluginSidePanel,
  openPluginPopover,
  closePluginPopover,
  openPluginCommandView,
  closePluginCommandView,
  resolveQuickPick,
  resolveInputBox,
  clearPluginSurfaces,
  dropWindowPluginSurfaces,
  nextSurfaceInstanceId,
  type Anchor,
} from "./surfaces";

export const showPluginLog = (name: string) => revealPluginLog(name);
export const showPluginsFolder = () => revealPluginsFolder();
export const pluginsFolderPath = () => (PLATFORM_FEATURES.plugins ? pluginsFolder() : "");
