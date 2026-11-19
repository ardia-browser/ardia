import { pluginsFolder, revealPluginLog, revealPluginsFolder } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { disablePlugin as turnOff } from "./lifecycle";
import { consentNow } from "../telemetry/choice";

export { dismissPluginConsent, enablePlugin, removePlugin, requestPluginConsent, setPluginValue, UNSAVED } from "./lifecycle";
export const disablePlugin = (name: string) => turnOff(name, consentNow());
export { restartProcess as restartPlugin } from "./process";
export { openPluginPage, pluginPagePath } from "./pages";
export { consentLines, type ConsentLine } from "./consent";
export { canRelink, relinkPrograms } from "./programs";
export { isAlwaysOn } from "./store";
export { installOfficialPlugin, officialPlugins, COMING_SOON, OFFICIAL_CATALOGUE, type OfficialPlugin, type OfficialPluginState } from "./official";
export type { InstallResult } from "./installWaiters";

export const showPluginLog = (name: string) => revealPluginLog(name);
export const showPluginsFolder = () => revealPluginsFolder();
export const pluginsFolderPath = () => (PLATFORM_FEATURES.plugins ? pluginsFolder() : "");
