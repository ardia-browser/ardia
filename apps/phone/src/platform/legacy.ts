import { legacyImport as native, legacySettled } from "@ardia/phone-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { LegacyApi } from "../state/legacy/importer";

const opensWithoutImport = typeof requireOptionalNativeModule<{ startFresh?: unknown }>("ArdiaPhoneLegacy")?.startFresh === "function";

export const legacyImport: LegacyApi = {
  source: () => native.source(),
  read: () => native.read(),
  readVisits: (afterId, limit) => native.readVisits(afterId, limit),
  applyNativeSettings: () => native.applyNativeSettings(),
  markImported: (receipt) => native.markImported(receipt),
  ...(opensWithoutImport ? { startFresh: () => native.startFresh() } : {}),
};

export const canStartWithoutImport = () => opensWithoutImport;

export type NativeImportState = "none" | "imported" | "startedFresh" | "pending" | "unknown";

export function nativeImportState(): NativeImportState {
  try {
    return legacySettled?.() ?? "unknown";
  } catch {
    return "pending";
  }
}
