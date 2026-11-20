import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { handlePluginSocketMethods } from "../automation/controlSocket";
import { startChannels } from "./channel";
import { consentToken } from "../telemetry/choice";
import { loadPluginRecords, rescanPlugins, watchPluginFolder } from "./lifecycle";
import { pluginSocketMethod } from "./socketMethods";
import { watchPageContexts } from "./pages";

let started = false;

export const registerPluginSocketMethods = () => handlePluginSocketMethods(pluginSocketMethod);

export function startPlugins() {
  if (started || !PLATFORM_FEATURES.plugins) return;
  started = true;
  loadPluginRecords();
  startChannels();
  watchPageContexts();
  registerPluginSocketMethods();
  watchPluginFolder();
  void rescanPlugins(consentToken());
}
