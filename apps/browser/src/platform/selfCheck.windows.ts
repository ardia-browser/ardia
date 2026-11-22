import { requireNativeModule } from "expo-modules-core";
import type { SelfCheckNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const selfChecks = requireNativeModule<SelfCheckNative>(t(`ArdiaSelfCheck`));
