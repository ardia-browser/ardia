import { defineModuleDomain } from "../define.ts";

export const sync = defineModuleDomain({
  kind: "module",
  package: "packages/sync",
  imports: {
    "../native.ts": ["FolderInfo", "PhraseResult", "SealedLogin", "SyncCore", "SyncOpenFailure"],
    "../scopeState.ts": ["Listing"],
    "../sharedFolders.ts": ["ResolvedSharedFolder", "SharedFolderIdentity", "SharedListing", "SharedLocation"],
  },
  types: {},
  modules: {
    ArdiaSync: {
      functions: {
        folderInfo: { args: [["path", "string | null", "String?"]], result: "FolderInfo", swiftResult: "[String: Any]", async: true, queue: "module", mac: "custom", desktop: "adapted", windows: "custom" },
        chooseFolder: { args: [["current", "string | null", "String?"]], result: "string | null", async: true, promise: true, queue: "main", deadline: 900000, mac: "custom", desktop: "adapted", windows: "custom" },
        newDeviceId: { args: [], result: "string", async: false, mac: "custom", desktop: "custom", windows: "custom" },
        takeOpenFailures: { args: [], result: "Partial<Record<SyncOpenFailure, number>>", swiftResult: "[String: Int]", async: false, optional: true, mac: "custom", desktop: "absent", windows: "absent" },
        deviceName: { args: [], result: "string", async: false, mac: "custom", desktop: "adapted", windows: "custom" },
        createPhrase: { args: [["account", "string"]], result: "boolean", async: true, queue: "module", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        enterPhrase: { args: [["account", "string"], ["text", "string"], ["folder", "string"]], result: "PhraseResult", swiftResult: "[String: Any]", async: true, queue: "module", instance: "strong", throws: true, deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        unlock: { args: [["account", "string"]], result: "boolean", async: true, queue: "module", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        forget: { args: [["account", "string"]], result: "void", async: true, queue: "module", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        chainStatus: { args: [["folder", "string"]], result: "\"ok\" | \"missing\" | \"unavailable\"", swiftResult: "String", async: true, queue: "module", throws: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        createChain: { args: [["folder", "string"]], result: "void", async: true, queue: "module", throws: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        write: { args: [["folder", "string"], ["scope", "string"], ["payload", "string"]], result: "string", async: true, queue: "module", throws: true, instance: "strong", deadline: 120000, mac: "custom", desktop: "adapted", windows: "custom" },
        read: { args: [["folder", "string"], ["scope", "string"], ["known", "string[]"]], result: "Listing", swiftResult: "[String: Any]", async: true, queue: "module", throws: true, instance: "strong", deadline: 120000, mac: "custom", desktop: "adapted", windows: "custom" },
        remove: { args: [["folder", "string"], ["scope", "string"], ["ids", "string[]"]], result: "void", async: true, queue: "module", throws: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        deleteChain: { args: [["folder", "string"]], result: "void", async: true, queue: "module", throws: true, instance: "strong", deadline: 120000, mac: "custom", desktop: "adapted", windows: "custom" },
        sealLocal: { args: [["text", "string"]], result: "string", async: true, queue: "module", throws: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        openLocal: { args: [["sealed", "string"]], result: "string | null", swiftResult: "String?", async: true, queue: "module", instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        recoveryWords: { args: [], result: "string[] | null", async: true, promise: true, queue: "module", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        qrCode: { args: [], result: "string | null", async: true, promise: true, queue: "module", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        recoveryKitPreview: { args: [["width", "number"]], result: "string | null", swiftResult: "String?", async: true, queue: "main", throws: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        saveRecoveryKit: { args: [["format", "\"pdf\" | \"text\"", "String"]], result: "string | null", async: true, promise: true, queue: "main", instance: "strong", deadline: 900000, mac: "custom", desktop: "adapted", windows: "custom" },
        copyRecoveryKit: { args: [], result: "boolean | null", async: true, promise: true, queue: "main", instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        shareRecoveryKit: { args: [], result: "boolean | null", async: true, promise: true, queue: "main", instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        copyRecoveryPhrase: { args: [], result: "boolean | null", async: true, promise: true, queue: "main", instance: "strong", deadline: 180000, mac: "custom", desktop: "adapted", windows: "custom" },
        revealFolder: { args: [["path", "string"]], result: "void", async: true, queue: "main", mac: "custom", desktop: "adapted", windows: "custom" },
        readPasswords: { args: [["engineProfile", "string"]], result: "SealedLogin[] | null", async: true, promise: true, instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        savePassword: { args: [["engineProfile", "string"], ["origin", "string"], ["username", "string"], ["sealed", "string"], ["replacing", "boolean"]], result: "boolean", async: true, promise: true, queue: "module", instance: "strong", mac: "custom", desktop: "adapted", windows: "custom" },
        takeFileCounts: { args: [], result: "{ placeholders: number; busy: number; hydrated: number }", async: false, optional: true, mac: "absent", desktop: "absent", windows: "custom" },
      },
      constants: {
        core: { type: "SyncCore | (() => Promise<string>)", swift: "String", optional: true, mac: "custom", desktop: "adapted", windows: "absent" },
      },
      events: {},
    },
    ArdiaSharedFolders: {
      functions: {
        location: { args: [], result: "SharedLocation", swiftResult: "[String: Any]", async: false, mac: "custom", desktop: "absent", windows: "absent" },
        read: { args: [["path", "string"], ["identity", "SharedFolderIdentity | null", "[String: Int]?"]], result: "SharedListing", swiftResult: "[String: Any]", async: true, queue: "module", mac: "custom", desktop: "absent", windows: "absent" },
        apply: { args: [["path", "string"], ["ops", "string"], ["identity", "SharedFolderIdentity | null", "[String: Int]?"]], result: "{ conflicts: string[] }", swiftResult: "[String: Any]", async: true, queue: "module", throws: true, mac: "custom", desktop: "absent", windows: "absent" },
        resolve: { args: [["path", "string"]], result: "ResolvedSharedFolder", async: true, promise: true, queue: "module", mac: "custom", desktop: "absent", windows: "absent" },
        discard: { args: [["path", "string"], ["identity", "SharedFolderIdentity", "[String: Int]"]], result: "boolean", async: true, queue: "module", mac: "custom", desktop: "absent", windows: "absent" },
        create: { args: [["parent", "string"], ["parentIdentity", "SharedFolderIdentity | null", "[String: Int]?"], ["name", "string"]], result: "ResolvedSharedFolder", swiftResult: "[String: Any]", async: true, queue: "module", throws: true, mac: "custom", desktop: "absent", windows: "absent" },
        watch: { args: [["paths", "string[]"]], result: "void", async: false, instance: "weak", mac: "custom", desktop: "absent", windows: "absent" },
      },
      events: {
        onChange: { payload: "{ paths: string[] }", mac: "custom", desktop: "absent", windows: "absent" },
      },
    },
  },
});
