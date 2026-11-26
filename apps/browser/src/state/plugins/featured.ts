import { useMemo } from "react";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { keyOfId } from "../../lib/pluginIds";
import { useCatalog, type CatalogEntry } from "./marketplace";
import { defaultRegistryKeys } from "./registryKeys";
import { activeManifest, recordOf, usePlugins, type PluginFetch, type PluginsStore, type ProgramsState } from "./store";
import type { InstallResult } from "./installWaiters";

export type FeaturedState = "available" | "installed" | "offline" | "loading" | "unsupported";

export type FeaturedPlugin = { name: string; id: string; title: string; blurb: string; icon: string; version: string | null; example: string | null; state: FeaturedState; update: string | null };

type Featured = { id: string; title: string; blurb: string; icon: string; example: string | null };

export const FEATURED: readonly Featured[] = [{ id: "@ardia/cli", title: "Command Line", blurb: "Drive Ardia from your terminal or an agent.", icon: "terminal.fill", example: "ardia tabs" }];

export const PRESELECTED_PLUGINS: readonly string[] = ["ardia__cli"];

type CatalogView = { state: "idle" | "loading" | "ready" | "offline"; entries: readonly CatalogEntry[] };

export const registryConfigured = () => Object.keys(defaultRegistryKeys()).length > 0;

export function featuredPlugins(s: Pick<PluginsStore, "listings" | "records">, catalog: CatalogView, supported: boolean = PLATFORM_FEATURES.plugins && registryConfigured()): FeaturedPlugin[] {
  return FEATURED.map((f) => {
    const name = keyOfId(f.id)!;
    const entry = catalog.entries.find((e) => e.id === f.id);
    const m = activeManifest(s, name);
    const shown = {
      name,
      id: f.id,
      title: m?.title ?? entry?.name ?? f.title,
      blurb: m?.description || entry?.description || f.blurb,
      icon: m?.icon ?? entry?.icon ?? f.icon,
      version: m?.version ?? entry?.tags.latest ?? null,
      example: m?.programs.find((p) => p.example)?.example ?? f.example,
      update: recordOf(s, name).pendingUpdate?.version ?? null,
    };
    if (!supported) return { ...shown, state: "unsupported" };
    if (m) return { ...shown, state: "installed" };
    if (entry) return { ...shown, state: "available" };
    return { ...shown, state: catalog.state === "offline" ? "offline" : catalog.state === "ready" ? "unsupported" : "loading" };
  });
}

export function useFeaturedPlugins(): FeaturedPlugin[] {
  const catalog = useCatalog();
  const key = usePlugins((s) => JSON.stringify(featuredPlugins(s, catalog)));
  return useMemo(() => JSON.parse(key) as FeaturedPlugin[], [key]);
}

export type FeaturedAttempt = { state: "installing" | "asking" } | { state: "failed"; reason: string } | null;

export type FeaturedView = { status: string | null; failed: boolean; busy: boolean; installed: boolean; firstCommand: string | null };

const progressText = (fetch: PluginFetch): string =>
  fetch.state === "fetching" ? (fetch.total ? `Downloading… ${Math.min(100, Math.round((fetch.received / fetch.total) * 100))}%` : "Downloading…") : fetch.state === "promoting" ? "Switching over…" : fetch.reason;

export function featuredView(plugin: FeaturedPlugin, programs: ProgramsState | undefined, attempt: FeaturedAttempt, fetch?: PluginFetch | null): FeaturedView {
  if (attempt?.state === "failed") return { status: attempt.reason, failed: true, busy: false, installed: false, firstCommand: null };
  if (attempt) return { status: fetch ? progressText(fetch) : attempt.state === "asking" ? "Waiting for you…" : "Installing…", failed: false, busy: true, installed: false, firstCommand: null };
  if (plugin.state === "offline") return { status: "Couldn't reach the plugin registry", failed: true, busy: false, installed: false, firstCommand: null };
  if (plugin.state === "loading") return { status: "Checking the plugin registry…", failed: false, busy: true, installed: false, firstCommand: null };
  if (plugin.state !== "installed") return { status: null, failed: false, busy: false, installed: false, firstCommand: null };
  if (programs?.state === "linking") return { status: "Putting its commands on your PATH…", failed: false, busy: true, installed: true, firstCommand: null };
  if (programs?.state === "failed") return { status: `Installed, but not on your PATH: ${programs.reason}`, failed: true, busy: false, installed: true, firstCommand: null };
  const refused = programs?.state === "linked" ? Object.values(programs.refused)[0] : undefined;
  if (refused) return { status: `Installed, but ${refused}`, failed: true, busy: false, installed: true, firstCommand: null };
  return { status: plugin.version ? `Installed · ${plugin.version}` : "Installed", failed: false, busy: false, installed: true, firstCommand: programs?.state === "linked" && plugin.example ? plugin.example : null };
}

export const wasCancelled = (result: InstallResult) => !result.ok && result.cancelled === true;

export function pluginSearchKeywords(s: Pick<PluginsStore, "listings" | "records" | "order">): Record<string, string[]> {
  const words = [...new Set(s.order.flatMap((name) => activeManifest(s, name)?.keywords ?? []))].sort();
  return words.length ? { "plugins.plugins": words } : {};
}

export function updateNoteText(note: { from: string | null; to: string | null; added: string[]; rolledBack?: true }): { title: string; description: string | undefined } {
  if (note.rolledBack) return { title: `Rolled back${note.to ? ` to ${note.to}` : ""}`, description: note.from ? `From ${note.from}` : undefined };
  const title = note.to ? `Updated to ${note.to}` : "Updated";
  return { title, description: note.added.length ? `It now also: ${note.added.slice(0, 3).join("; ")}` : note.from ? `From ${note.from}, with nothing new to approve` : undefined };
}
