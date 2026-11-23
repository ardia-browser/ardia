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
export { consentLines, fullControlLine, FULL_CONTROL_SUMMARY } from "./consent";
export { canRelink, relinkPrograms } from "./programs";
export { installOfficialPlugin, officialPlugins, COMING_SOON, OFFICIAL_CATALOGUE, type OfficialPlugin } from "./official";
export { ensurePluginActivated } from "./activation";
export { runPluginAction, pluginBarActions } from "./commands";
export { runPluginToolbarItem, type PluginToolbarEntry } from "./toolbar";
export { setPluginSecretRow, pluginSecretRowIsSet } from "./secretRows";
export {
  mountPluginSurface,
  unmountPluginSurface,
  dispatchPluginSurfaceEvent,
  openPluginSidePanel,
  closePluginSidePanel,
  openPluginPopover,
  closePluginPopover,
  closePluginCommandView,
  resolveQuickPick,
  resolveInputBox,
  nextSurfaceInstanceId,
  type Anchor,
} from "./surfaces";

export const showPluginLog = (name: string) => revealPluginLog(name);
export const showPluginsFolder = () => revealPluginsFolder();
export const pluginsFolderPath = () => (PLATFORM_FEATURES.plugins ? pluginsFolder() : "");
