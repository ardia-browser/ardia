import { requireNativeModule } from "expo-modules-core";
import type { WindowsUpdateCountsNative } from "@ardia/shell";

export const windowsUpdateCounts = requireNativeModule<WindowsUpdateCountsNative>("ArdiaWindowsUpdateCounts");
