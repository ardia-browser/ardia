import pin from "../../../official-plugins.json";
import type { experimentOn } from "../../platform/killSwitches";

export type OfficialEntry = { name: string; title: string; blurb: string; icon: string };
type Experiment = Parameters<typeof experimentOn>[0];
export type OfficialTelemetry = { title: string; items: string[] };
type PinEntry = OfficialEntry & { preselected?: boolean; anchorAliases?: readonly string[]; telemetry?: OfficialTelemetry; example?: string };
type Pin = { plugins: readonly PinEntry[]; comingSoon?: readonly (OfficialEntry & { experiment: string })[] };

const entryOf = ({ name, title, blurb, icon }: OfficialEntry): OfficialEntry => ({ name, title, blurb, icon });

export function officialCatalogue(given: Pin) {
  return {
    plugins: given.plugins.map(entryOf),
    comingSoon: (given.comingSoon ?? []).map((soon) => ({ ...entryOf(soon), experiment: soon.experiment as Experiment })),
    preselected: given.plugins.filter((p) => p.preselected === true).map((p) => p.name),
    examples: Object.fromEntries(given.plugins.flatMap((p) => (typeof p.example === "string" ? [[p.name, p.example]] : []))) as Record<string, string>,
    telemetry: Object.fromEntries(given.plugins.flatMap((p) => (p.telemetry ? [[p.name, { title: p.telemetry.title, items: [...p.telemetry.items] }]] : []))) as Record<string, OfficialTelemetry>,
    anchorAliases: Object.fromEntries(given.plugins.map((p) => [p.name, [...(p.anchorAliases ?? [])]])) as Record<string, string[]>,
  };
}

const CATALOGUE = officialCatalogue(pin as Pin);

export const OFFICIAL_CATALOGUE: readonly OfficialEntry[] = CATALOGUE.plugins;
export const COMING_SOON: readonly (OfficialEntry & { experiment: Experiment })[] = CATALOGUE.comingSoon;
export const PRESELECTED_PLUGINS: readonly string[] = CATALOGUE.preselected;
export const OFFICIAL_NAMES: readonly string[] = [...CATALOGUE.plugins, ...CATALOGUE.comingSoon].map((p) => p.name);
export const OFFICIAL_ANCHOR_ALIASES: Readonly<Record<string, readonly string[]>> = CATALOGUE.anchorAliases;
export const OFFICIAL_TELEMETRY: Readonly<Record<string, OfficialTelemetry>> = CATALOGUE.telemetry;
export const OFFICIAL_EXAMPLES: Readonly<Record<string, string>> = CATALOGUE.examples;
