import { serviceModules as sharedServiceModules } from "./modules.ts";

const CLI_NOT_ON_LINUX = "The ardia command isn't on Linux yet";

export const serviceModules: Record<string, Record<string, unknown>> = {
  ...sharedServiceModules,
  ArdiaCli: {
    installedVersion: () => null,
    canInstallUnattended: () => false,
    install: async () => ({ ok: false, appVersion: "", error: CLI_NOT_ON_LINUX, installedVersion: null, lines: [] }),
  },
  ArdiaScripting: { setScriptState: () => {} },
};
