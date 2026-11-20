import { consentToken, type ConsentToken } from "./consentPeriod";
import { consentOrNow, countFor } from "./countFor";

export { consentToken };

export const OFFICIAL_SURFACES = ["onboarding", "settings"] as const;
export const OFFICIAL_EVENTS = ["shown", "installed", "skipped", "failed"] as const;
export const OFFICIAL_COUNTED_NAMES = ["cli", "ai"] as const;

export type OfficialSurface = (typeof OFFICIAL_SURFACES)[number];
export type OfficialEvent = (typeof OFFICIAL_EVENTS)[number];
type CountedName = (typeof OFFICIAL_COUNTED_NAMES)[number] | "other";

const countedName = (name: string): CountedName => ((OFFICIAL_COUNTED_NAMES as readonly string[]).includes(name) ? (name as CountedName) : "other");

export const officialPluginField = (surface: OfficialSurface, event: OfficialEvent, name: string) => `official_plugin_${surface}_${event}_${countedName(name)}`;

let counts: Record<string, number> = {};

export function noteOfficialPlugin(surface: OfficialSurface, event: OfficialEvent, name: string, consent?: ConsentToken | null) {
  if (surface === "settings" && event === "skipped") return;
  const field = officialPluginField(surface, event, name);
  countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + 1));
}

export function takeOfficialPluginCounts(): Record<string, number> {
  const taken = counts;
  counts = {};
  return taken;
}
