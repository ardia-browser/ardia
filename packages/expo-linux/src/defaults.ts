const documents = new Map<string, string>();

const SYSTEM_INFO = {
  appName: "Ardia",
  appVersion: "0.0.0",
  appBuild: "linux",
  bundleId: "dev.ardia.linux",
  configuration: "Release",
  osVersion: "Linux",
  osBuild: "linux",
  arch: "x64",
  model: "PC",
  memoryGB: 8,
  locale: typeof navigator === "undefined" ? "en-US" : navigator.language,
};

const LAUNCH_CONFIG = {
  dataDirectory: null,
  configDirectory: "",
  background: false,
  isolated: false,
  testInstance: false,
  instance: {},
  switches: {},
  trace: [],
  test: {},
};

export const moduleDefaults: Record<string, Record<string, unknown>> = {
  ArdiaApp: { launchEnvironment: () => null, systemInfo: () => SYSTEM_INFO, launchConfig: () => LAUNCH_CONFIG, appIcons: async () => [], appIcon: async () => null },
  ArdiaDocuments: {
    readDocument: (name: string) => documents.get(name) ?? null,
    writeDocument: (name: string, contents: string) => void documents.set(name, contents),
    saveDocument: async (name: string, contents: string) => void documents.set(name, contents),
    removeDocument: (name: string) => void documents.delete(name),
  },
  ArdiaCalendar: { authorizationStatus: () => "notDetermined" },
  ArdiaCli: { installedVersion: () => null },
  ArdiaGlassEffect: { isLiquidGlass: () => false },
  ArdiaUserScripts: { watch: () => {}, read: async () => ({ state: "empty" }), readStatus: async () => null },
  ArdiaMenus: { menuShortcuts: async () => [] },
  ArdiaSystem: { fileExists: () => false, hapticTick: () => {} },
  ArdiaShell: { isDarkAppearance: async () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches },
};
