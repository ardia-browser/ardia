import { requireNativeModule } from "expo-modules-core";

export const engineCounts = requireNativeModule<{ take(): Record<string, number> }>("ArdiaLinuxCounts");
