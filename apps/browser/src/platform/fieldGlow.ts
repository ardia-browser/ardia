import { requireOptionalNativeModule } from "expo-modules-core";
import type { FieldGlowNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const fieldGlow = requireOptionalNativeModule<FieldGlowNative>(t(`ArdiaFieldGlow`));
