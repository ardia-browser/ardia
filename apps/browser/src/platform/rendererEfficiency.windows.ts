import { requireNativeModule } from "expo-modules-core";
import type { RendererEfficiencyNative } from "@ardia/shell";

export const rendererEfficiency = requireNativeModule<RendererEfficiencyNative>("ArdiaRendererEfficiency");
