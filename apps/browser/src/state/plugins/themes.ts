import { parseThemeFile, type ParsedTheme, type RolePalettes } from "../../lib/themeFile";
import { activeManifest, activeNames, currentPlugins, recordOf, type PluginsStore } from "./store";
import { readFolderFile } from "./hostIo";

export type PluginTheme = { plugin: string; pluginTitle: string; id: string; title: string; key: string };

export const pluginThemeKey = (plugin: string, id: string) => `plugin:${plugin}/${id}`;

export function parsePluginThemeKey(key: string): { plugin: string; id: string } | null {
  const found = /^plugin:([a-z0-9][a-z0-9-]{0,39})\/([A-Za-z0-9_-]{1,40})$/.exec(key);
  return found ? { plugin: found[1]!, id: found[2]! } : null;
}

export function pluginThemes(s: Pick<PluginsStore, "listings" | "records" | "order"> = currentPlugins()): PluginTheme[] {
  return activeNames(s).flatMap((plugin) => {
    const m = activeManifest(s, plugin)!;
    return m.contributes.themes.map((t) => ({ plugin, pluginTitle: m.title, id: t.id, title: t.title, key: pluginThemeKey(plugin, t.id) }));
  });
}

export type PluginThemeLoad = { ok: true; theme: ParsedTheme } | { ok: false; reason: string };

export async function loadPluginTheme(plugin: string, themeId: string, defaults: RolePalettes): Promise<PluginThemeLoad> {
  const s = currentPlugins();
  const m = activeManifest(s, plugin);
  const spec = m?.contributes.themes.find((t) => t.id === themeId);
  const listing = s.listings[plugin];
  const approved = recordOf(s, plugin).approved ?? listing?.hash ?? null;
  if (!m || !spec || !listing || !approved) return { ok: false, reason: `${plugin} has no theme ${themeId} that is on.` };
  const read = await readFolderFile(plugin, listing.folderId, approved, spec.file);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (currentPlugins().listings[plugin]?.hash !== listing.hash) return { ok: false, reason: `${plugin} changed while its theme loaded.` };
  const theme = parseThemeFile(`${plugin}/${spec.file}`, read.text, defaults);
  return theme.roles ? { ok: true, theme } : { ok: false, reason: theme.problems[0] ?? "The theme couldn't be read." };
}
