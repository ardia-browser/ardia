import { defineModuleDomain } from "../define.ts";

export const importModules = defineModuleDomain({
  kind: "module",
  package: "packages/import",
  imports: {
    "../index": ["ImportEvent", "ImportKind", "NativeImportOptions"],
  },
  types: {},
  modules: {
    ArdiaImport: {
      functions: {
        listBrowsers: { args: [], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        importData: { args: [["jobId", "string"], ["browserId", "string"], ["profileId", "string"], ["kinds", "ImportKind[]", "[ImportKind]"], ["options", "NativeImportOptions", "ImportRequestOptions"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "absent", windows: "custom" },
        cancelImport: { args: [["jobId", "string"]], result: "void | Promise<void>", swiftResult: "Void", async: false, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        unlockBrowser: { args: [["browserId", "string"], ["primaryPassword", "string | null", "String?"]], result: "null", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        isBrowserUnlocked: { args: [["browserId", "string"]], result: "boolean", async: false, instance: "strong", mac: "custom", desktop: "absent", windows: "custom" },
        forgetUnlockedKeys: { args: [], result: "void | Promise<void>", swiftResult: "Void", async: false, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        writeImported: { args: [["token", "string"], ["profile", "string"], ["kinds", "(\"cookies\" | \"autofill\")[]", "[ImportKind]"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        discardImported: { args: [["token", "string"]], result: "void | Promise<void>", swiftResult: "Void", async: false, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        listExtensions: { args: [["browserId", "string"], ["profileId", "string"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        importSafariExport: { args: [["jobId", "string"], ["path", "string"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "absent", windows: "custom" },
        safariHasFullDiskAccess: { args: [], result: "boolean", async: false, mac: "custom", desktop: "absent", windows: "custom" },
        openFullDiskAccessSettings: { args: [], result: "null", async: true, promise: true, queue: "main", mac: "custom", desktop: "absent", windows: "custom" },
        importSafariDirect: { args: [["jobId", "string"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "absent", windows: "custom" },
        readDiaTabs: { args: [], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "absent", windows: "custom" },
        importBookmarksHTML: { args: [["path", "string"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        importPasswordsCSV: { args: [["path", "string"]], result: "string", async: true, promise: true, instance: "strong", mac: "custom", desktop: "host", windows: "custom" },
        chooseImportFile: { args: [["kind", "\"safariExport\" | \"bookmarksHTML\" | \"passwordsCSV\"", "ImportFileKind"]], result: "string | null", async: true, promise: true, queue: "main", mac: "custom", desktop: "host", windows: "custom" },
      },
      events: {
        onImportEvent: { payload: "ImportEvent", mac: "custom", desktop: "host", windows: "custom" },
      },
    },
  },
});
