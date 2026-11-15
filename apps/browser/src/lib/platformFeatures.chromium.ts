import type { PlatformFeatures } from "./platformFeatures";
import { PLATFORM_FEATURES as ON_ELECTRON } from "./platformFeatures.linux.ts";

export const PLATFORM_FEATURES: PlatformFeatures = { ...ON_ELECTRON, contentBlocker: true };
