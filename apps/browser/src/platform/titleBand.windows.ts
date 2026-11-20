import { requireNativeModule } from "expo-modules-core";
import type { TitleBandNative } from "@ardia/shell";

export const titleBand = requireNativeModule<TitleBandNative>("ArdiaTitleBand");
