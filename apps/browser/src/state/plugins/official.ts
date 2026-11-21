import { useMemo } from "react";
import { COMING_SOON, OFFICIAL_CATALOGUE, OFFICIAL_EXAMPLES } from "./officialPin";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { experimentOn } from "../../platform/killSwitches";
import { openSettings } from "../settings/settingsWindows";
import { waitForInstall, type InstallResult } from "./installWaiters";
import { releaseOrphanedConsent } from "./consentSurface";
import { ALREADY_ASKING, requestPluginConsent } from "./lifecycle";
import { relinkPrograms } from "./programs";
import { activeManifest, currentPlugins, isAlwaysOn, isInstalled, usePlugins, type PluginListing, type PluginsStore } from "./store";

export { COMING_SOON, OFFICIAL_CATALOGUE, OFFICIAL_NAMES, PRESELECTED_PLUGINS, officialCatalogue } from "./officialPin";

export type OfficialPluginState = "available" | "installed" | "comingSoon" | "unsupported";
export type OfficialPlugin = { name: string; title: string; blurb: string; icon: string; version: string | null; example: string | null; switchable: boolean; state: OfficialPluginState };
type Entry = Omit<OfficialPlugin, "state" | "version" | "switchable" | "example">;
type ComingSoon = (typeof COMING_SOON)[number];

const officialListing = (s: Pick<PluginsStore, "listings">, name: string): PluginListing | undefined => {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  return listing?.bundled && listing.manifest?.official ? listing : undefined;
};

function installedOf(s: Pick<PluginsStore, "listings" | "records">, listing: PluginListing): boolean {
  return isAlwaysOn(listing) ? isInstalled(s, listing.name) : !!activeManifest(s, listing.name);
}

export function officialPlugins(
  s: Pick<PluginsStore, "listings" | "records" | "order">,
  supported: boolean = PLATFORM_FEATURES.plugins,
  showComingSoon: (experiment: ComingSoon["experiment"]) => boolean = experimentOn,
): OfficialPlugin[] {
  const bundled = s.order.filter((name) => officialListing(s, name)).map((name) => ({ name, title: "", blurb: "", icon: "" }));
  const entries = [...OFFICIAL_CATALOGUE, ...bundled.filter((b) => !OFFICIAL_CATALOGUE.some((e) => e.name === b.name))];
  const out: OfficialPlugin[] = entries.map((entry) => {
    const listing = officialListing(s, entry.name);
    const m = listing?.manifest;
    const shown = { name: entry.name, title: m?.title ?? entry.title, blurb: m?.description || entry.blurb, icon: m?.icon ?? m?.page?.icon ?? (entry.icon || "puzzlepiece"), version: m?.version ?? null, example: m?.programs.find((p) => p.example)?.example ?? (listing && Object.hasOwn(OFFICIAL_EXAMPLES, entry.name) ? OFFICIAL_EXAMPLES[entry.name]! : null), switchable: !!listing && !isAlwaysOn(listing) };
    if (!supported || !listing) return { ...shown, state: "unsupported" };
    return { ...shown, state: installedOf(s, listing) ? "installed" : "available" };
  });
  for (const soon of COMING_SOON) {
    if (!showComingSoon(soon.experiment) || out.some((o) => o.name === soon.name)) continue;
    out.push({ name: soon.name, title: soon.title, blurb: soon.blurb, icon: soon.icon, version: null, example: null, switchable: false, state: supported ? "comingSoon" : "unsupported" });
  }
  return out;
}

export function officialKeywords(s: Pick<PluginsStore, "listings" | "order">): Record<string, string[]> {
  return Object.fromEntries(s.order.flatMap((name) => {
    const keywords = officialListing(s, name)?.manifest?.keywords ?? [];
    return keywords.length ? [[`plugins.${name}`, keywords]] : [];
  }));
}

export function useOfficialPlugins(): OfficialPlugin[] {
  const key = usePlugins((s) => JSON.stringify(officialPlugins(s)));
  return useMemo(() => JSON.parse(key) as OfficialPlugin[], [key]);
}

function linkOutcome(name: string): InstallResult | null {
  const s = currentPlugins();
  const manifest = activeManifest(s, name);
  if (!manifest) return { ok: false, reason: "It changed while installing. Try again." };
  if (!manifest.programs.length) return { ok: true };
  const programs = s.programs[name];
  if (!programs || programs.state === "linking" || programs.hash !== s.listings[name]?.hash) return null;
  if (programs.state === "failed") return { ok: false, reason: `Installed, but not on your PATH: ${programs.reason}` };
  if (programs.adoption === "retrying") return null;
  if (programs.adoption === "busy") return { ok: false, reason: "Installed, but the old install is busy updating. Try again in a moment." };
  if (programs.adoption === "failed") return { ok: false, reason: "Installed, but the old install couldn't be switched over to it." };
  const refused = Object.values(programs.refused);
  return refused.length ? { ok: false, reason: `Installed, but ${refused[0]}` } : { ok: true };
}

function linked(name: string): Promise<InstallResult> {
  return new Promise((resolve) => {
    const now = linkOutcome(name);
    if (now) return resolve(now);
    const stop = usePlugins.subscribe(() => {
      const outcome = linkOutcome(name);
      if (!outcome) return;
      stop();
      resolve(outcome);
    });
  });
}

export function installOfficialPlugin(name: string, options: { showSheet?: boolean } = {}): Promise<InstallResult> {
  if (!PLATFORM_FEATURES.plugins) return Promise.resolve({ ok: false, reason: `Not available on ${PLATFORM_TERMS.os} yet.` });
  const s = currentPlugins();
  const listing = officialListing(s, name);
  if (!listing) return Promise.resolve({ ok: false, reason: "Not an official plugin." });
  if (installedOf(s, listing)) {
    relinkPrograms(name);
    return linked(name);
  }
  if (!listing.manifest || !listing.hash) return Promise.resolve({ ok: false, reason: listing.problems[0] ?? "It can't load." });
  releaseOrphanedConsent();
  if (currentPlugins().consent) return Promise.resolve({ ok: false, reason: ALREADY_ASKING });
  if (!requestPluginConsent(name)) return Promise.resolve({ ok: false, reason: "Can't install it right now." });
  const done = waitForInstall(name);
  if (options.showSheet !== false) openSettings("plugins", null, name);
  return done.then((result) => (result.ok ? linked(name) : result));
}
