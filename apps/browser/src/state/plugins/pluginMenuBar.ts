import { pluginShortcutKeyChar, pluginShortcutModifiers, pluginShortcutOf } from "../../lib/pluginShortcuts";
import type { PluginManifest } from "../../lib/pluginManifest";
import { comboKey, normalShortcut, type Shortcut, type ShortcutSource } from "../commands/shortcuts";
import type { BrowserState } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import type { ConsentToken } from "../telemetry/choice";
import { runPluginCommand } from "./commands";
import { manifestInProfile } from "./profileScope";
import { activeManifest, activeNames, currentPlugins, usePlugins, type PluginsStore } from "./store";

export const PLUGIN_MENU_ITEM = "plugin:";
const MENU_ITEM_ID = "openExtension";
const MAX_ITEMS = 64;

type Plugins = Pick<PluginsStore, "listings" | "records" | "order">;
type Entry = { plugin: string; m: PluginManifest; command: string; title: string; shortcut: Shortcut | null };

export const pluginMenuItemId = (plugin: string, command: string) => `${PLUGIN_MENU_ITEM}${plugin}/${command}`;
export const shortcutIdOf = (itemId: string) => `${MENU_ITEM_ID}:${itemId}`;

export function parsePluginMenuItem(arg: string): { plugin: string; command: string } | null {
  if (!arg.startsWith(PLUGIN_MENU_ITEM)) return null;
  const [plugin, command, ...rest] = arg.slice(PLUGIN_MENU_ITEM.length).split("/");
  return plugin && command && !rest.length ? { plugin, command } : null;
}

export function pluginMenuShortcut(raw: unknown): Shortcut | null {
  const parsed = pluginShortcutOf(raw);
  return parsed ? normalShortcut(pluginShortcutKeyChar(parsed), pluginShortcutModifiers(parsed)) : null;
}

function entriesFor(plugins: Plugins, profileId: string | null | "any"): Entry[] {
  const out: Entry[] = [];
  for (const plugin of activeNames(plugins)) {
    const m = profileId === "any" ? activeManifest(plugins, plugin) : manifestInProfile(plugins, plugin, profileId);
    if (!m?.main) continue;
    for (const command of m.commands) {
      if (out.length >= MAX_ITEMS) return out;
      const declared = (m.v3.contributes?.commands ?? []).find((c) => c.name === command.name);
      out.push({ plugin, m, command: command.name, title: `${m.title}: ${command.title}`, shortcut: pluginMenuShortcut(declared?.shortcut) });
    }
  }
  return out;
}

export function pluginMenuBarItems(s: Pick<BrowserState, "windows">, windowId: string | undefined, plugins: Plugins = currentPlugins()) {
  const w = windowId ? s.windows[windowId] : undefined;
  if (!w || w.kind === "private") return [];
  return entriesFor(plugins, w.profileId).map((e) => ({ id: pluginMenuItemId(e.plugin, e.command), title: e.title, icon: null, enabled: true }));
}

export function pluginShortcutSources(taken: (shortcut: Shortcut) => boolean, plugins: Plugins = currentPlugins()): ShortcutSource[] {
  const claimed = new Set<string>();
  return entriesFor(plugins, "any").map((e) => {
    const id = shortcutIdOf(pluginMenuItemId(e.plugin, e.command));
    if (!e.shortcut) return { id, keys: [] };
    const key = comboKey(e.shortcut);
    if (taken(e.shortcut) || claimed.has(key)) return { id, keys: [] };
    claimed.add(key);
    return { id, keys: [e.shortcut] };
  });
}

export function runPluginMenuBarItem(windowId: string, arg: string, consent?: ConsentToken | null): boolean {
  const parsed = parsePluginMenuItem(arg);
  if (!parsed) return false;
  notePlugin("plugin_action_shortcuts", consent);
  void runPluginCommand(parsed.plugin, parsed.command, windowId, { from: "menuBar" }, undefined, consent).catch(() => undefined);
  return true;
}

export const pluginShortcutSignature = (plugins: Plugins = currentPlugins()) =>
  entriesFor(plugins, "any")
    .map((e) => `${pluginMenuItemId(e.plugin, e.command)}=${e.shortcut ? comboKey(e.shortcut) : ""}`)
    .join(",");

export const onPluginMenuBarChange = (listener: () => void) =>
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) listener();
  });
