import { noteMissing } from "./missing";

const ENGINE_ONLY: Record<string, string[]> = {
  ArdiaHistory: ["query", "add", "import", "deleteUrls", "watch"],
  ArdiaBookmarks: ["tree", "apply", "watch"],
  ArdiaFavicons: ["get", "set"],
  ArdiaTabs: ["lastTabPolicy"],
  ArdiaEngine: ["batterySaver", "trimMemory", "openTaskManager", "cliControlStatus", "setCliControl", "setCliActiveTab", "cliTabTargets", "cliOwnsTab", "cliMoveOffscreen", "cliCloseOffscreenTabs", "cliPluginCredential", "cliActDocument", "cliActLease", "cliActRelease", "cliTestPointer"],
  ArdiaExtensions: ["watchActions", "syncState", "syncApply"],
  ArdiaDownloads: ["settings", "setSettings"],
};

const ENGINE_ANSWERS: Record<string, Record<string, unknown>> = {
  ArdiaTabs: { strips: { rev: 0, cmd: null, strips: [] }, routeLinkTabs: {} },
  ArdiaExtensions: { list: { extensions: [] } },
  ArdiaSearch: { engines: { list: { engines: [] } } },
  ArdiaWindows: { list: [] },
};

const engineDomains = Object.fromEntries(
  [...new Set([...Object.keys(ENGINE_ONLY), ...Object.keys(ENGINE_ANSWERS)])].map((module) => [
    module,
    {
      call: async (name: string) => {
        if (ENGINE_ONLY[module]?.includes(name)) throw Object.assign(new Error(`${name} needs the engine, which Windows doesn't have yet`), { code: "ERR_ENGINE" });
        const answer = ENGINE_ANSWERS[module]?.[name];
        if (answer === undefined) noteMissing(`${module}.call ${name}`);
        return JSON.stringify(answer ?? null);
      },
    },
  ]),
);

export const moduleDefaults: Record<string, Record<string, unknown>> = {
  ...engineDomains,
  ArdiaApp: { launchEnvironment: () => null, windowsApiVersion: 0, interfaceScale: () => 1, interfaceScaleRange: () => [1, 1], setInterfaceScale: async () => 1 },
  ArdiaCalendar: { authorizationStatus: () => "notDetermined" },
  ArdiaCli: {
    installedVersion: () => null,
    canInstallUnattended: () => false,
    install: async () => ({ ok: false, appVersion: "", error: "The ardia command isn't offered on Windows yet.", lines: [] }),
  },
  ArdiaGlassEffect: { isLiquidGlass: () => false },
  ArdiaTranslate: { available: false, userLanguages: () => ["en"], languageName: (id: string) => id },
  ArdiaUserScripts: { watch: () => {}, read: async () => ({ state: "empty" }), readStatus: async () => null },
};
