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
import { watchOfficialUpdates } from "./official";
import { watchPageBarCommits } from "./pageBarCommits";
import { watchCredentialProviders } from "./credentialProviders";

let started = false;

export const registerPluginSocketMethods = () => handlePluginSocketMethods(pluginSocketMethod);

export function startPlugins() {
  if (started || !PLATFORM_FEATURES.plugins) return;
  started = true;
  loadPluginRecords();
  startChannels();
  watchActivation();
  watchCredentialProviders();
  watchSurfaceRemounts();
  watchPageContexts();
  registerPluginSocketMethods();
  watchPluginFolder();
  watchOfficialUpdates();
  watchPageBarCommits();
  void rescanPlugins(consentToken());
  watchPluginOmnibox();
}
