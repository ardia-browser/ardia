import { TurboModuleRegistry } from "react-native";
import type { WindowsImportModule } from "../nativeModuleTypes";
import type { ImportHost } from "@ardia/import/src/readers/index.ts";
import { windowsBrowsers } from "./browsers";

export const NATIVE_IMPORT = "ArdiaWindowsImport";

const text = (value: unknown) => (typeof value === "string" ? value : "");

const parsed = async <Value>(promise: Promise<string>): Promise<Value> => JSON.parse(await promise) as Value;

export function nativeImportHost(): ImportHost | null {
  const native = TurboModuleRegistry.get<WindowsImportModule>(NATIVE_IMPORT);
  if (!native) return null;
  const constants = native.getConstants?.() ?? {};
  return {
    platform: "Windows",
    separator: "\\",
    browsers: windowsBrowsers(text(constants.localAppData), text(constants.roamingAppData)),
    list: (path) => parsed(native.list(path)),
    readText: (path, largest) => native.readText(path, largest),
    readBase64: (path, largest) => native.readBase64(path, largest),
    readTextWithin: (folder, path, largest) => native.readTextWithin(folder, path, largest),
    readBase64Within: (folder, path, largest) => native.readBase64Within(folder, path, largest),
    query: (path, queries) => parsed(native.query(path, queries)),
    openSnapshot: (path) => parsed(native.openSnapshot(path)),
    querySnapshot: (id, queries) => parsed(native.querySnapshot(id, queries)),
    closeSnapshot: (id) => native.closeSnapshot(id),
    unlock: (browserId, localState) => parsed(native.unlock(browserId, localState)),
    logins: (browserId, files) => parsed(native.logins(browserId, files)),
    cookies: (browserId, file) => parsed(native.cookies(browserId, file)),
    firefoxLogins: (profile) => parsed(native.firefoxLogins(profile)),
    firefoxCookies: (file) => parsed(native.firefoxCookies(file)),
    autofill: (browserId, file, joinToken) => parsed(native.autofill(browserId, file, joinToken)),
    writeImported: (token, profile, kinds) => parsed(native.writeImported(token, profile, kinds)),
    discard: (token) => native.discard(token),
    forget: () => native.forget(),
  };
}
