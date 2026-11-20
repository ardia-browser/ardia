import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export const BackedView = requireNativeViewManager<ViewProps>("ArdiaBackedView");
