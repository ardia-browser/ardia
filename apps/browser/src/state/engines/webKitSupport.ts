import { systemInfo } from "../../platform/app";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

export const macOSAtLeast = (version: string, major: number, minor: number) => {
  const [have = 0, haveMinor = 0] = version.split(".").map(Number);
  return have > major || (have === major && haveMinor >= minor);
};

let extensions: boolean | null = null;

export const webKitRunsExtensions = () => (extensions ??= PLATFORM_FEATURES.webKit && macOSAtLeast(systemInfo().osVersion ?? "", 15, 4));
