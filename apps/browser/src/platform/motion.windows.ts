import { requireNativeModule } from "expo-modules-core";
import type { MotionNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const animationBursts = requireNativeModule<MotionNative>(t(`ArdiaMotion`));
