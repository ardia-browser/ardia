import { requireNativeModule } from "expo-modules-core";
import type { SelfCheckNative } from "@ardia/shell";

export const selfChecks = requireNativeModule<SelfCheckNative>("ArdiaSelfCheck");
