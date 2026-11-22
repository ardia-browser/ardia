import { requireOptionalNativeModule } from "expo-modules-core";
import type { FieldGlowNative } from "@ardia/shell";

export const fieldGlow = requireOptionalNativeModule<FieldGlowNative>("ArdiaFieldGlow");
