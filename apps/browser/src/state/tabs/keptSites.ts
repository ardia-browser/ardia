import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import type { Settings } from "../settings/settings";

export const keptSitesListed = (s: Pick<Settings, "memorySaver" | "busyTabWarnings">) => s.memorySaver !== false || (PLATFORM_FEATURES.busyTabWatch && s.busyTabWarnings !== false);
