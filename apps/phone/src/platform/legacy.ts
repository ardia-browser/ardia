import { legacyImport as native } from "@ardia/phone-native";
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
