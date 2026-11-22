import { requireNativeModule } from "expo-modules-core";
import type { ExternalAppCountsNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const externalAppCounts = requireNativeModule<ExternalAppCountsNative>(t(`ArdiaExternalAppCounts`));
