import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { handlePluginSocketMethods } from "../automation/controlSocket";
import { startChannels } from "./channel";
import { consentToken } from "../telemetry/choice";
import { loadPluginRecords, rescanPlugins, watchPluginFolder } from "./lifecycle";
import { pluginSocketMethod } from "./socketMethods";
import { watchPageContexts } from "./pages";
import { watchActivation } from "./activation";
import { watchPluginOmnibox } from "./omnibox";
import { watchSurfaceRemounts } from "./surfaces";
import { watchPluginUpdates } from "./updater";
import { migrateLegacyPlugins } from "./migration";
import { handlePluginInstallLinks } from "./installLinks";
import { installFromDeepLink } from "./marketplace";
import { watchPageBarCommits } from "./pageBarCommits";
import { startRuntimeV3 } from "./runtimeV3";

let started = false;

export const registerPluginSocketMethods = () => handlePluginSocketMethods(pluginSocketMethod);

export function startPlugins() {
  if (started || !PLATFORM_FEATURES.plugins) return;
  started = true;
  loadPluginRecords();
  startChannels();
  watchActivation();
  watchSurfaceRemounts();
  watchPageContexts();
  registerPluginSocketMethods();
  handlePluginInstallLinks(installFromDeepLink);
  watchPluginFolder();
  watchPluginUpdates();
  watchPageBarCommits();
  startRuntimeV3();
  const consent = consentToken();
  void migrateLegacyPlugins(consent).finally(() => void rescanPlugins(consent));
  watchPluginOmnibox();
}
