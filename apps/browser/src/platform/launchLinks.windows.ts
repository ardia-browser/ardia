import { requireNativeModule } from "expo-modules-core";
import type { LaunchLinksNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const launchLinks = requireNativeModule<LaunchLinksNative>(t(`ArdiaLaunchLinks`));
