import { importModules } from "../chromium/import";
import { introMusicModules } from "../chromium/introMusic";
import { keysModules } from "../chromium/keys";
import { launchLinksModules } from "../chromium/launchLinks";
import { syncModules } from "../chromium/sync";
import { updaterModules } from "../chromium/updater";
import { serviceModules as sharedServiceModules } from "./modules.ts";

const CLI_NOT_ON_LINUX = "The ardia command isn't on Linux yet";

export const serviceModules: Record<string, Record<string, unknown>> = {
  ...sharedServiceModules,
  ...importModules,
  ...introMusicModules,
  ...keysModules,
  ...launchLinksModules,
  ...syncModules,
  ...updaterModules,
  ArdiaCli: {
    installedVersion: () => null,
    canInstallUnattended: () => false,
    install: async () => ({ ok: false, appVersion: "", error: CLI_NOT_ON_LINUX, installedVersion: null, lines: [] }),
  },
  ArdiaScripting: { setScriptState: () => {} },
};
