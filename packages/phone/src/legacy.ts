import { requireOptionalNativeModule } from "expo-modules-core";
import { legacyApis, type LegacyNative } from "./legacyApi";

export type { LegacyCounts, LegacyData, LegacyRead, LegacyReceipt, LegacySource, LegacyTab, LegacyUnusableReason, LegacyVisit, LegacyVisitPage } from "./legacyApi";

export const { legacyImport, legacy, legacyLab, legacySettled } = legacyApis(requireOptionalNativeModule<LegacyNative>("ArdiaPhoneLegacy"));
