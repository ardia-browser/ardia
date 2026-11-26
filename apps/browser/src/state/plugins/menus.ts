import { whenHolds, type WhenContext } from "../../lib/pluginWhen";
import type { MenuSlot } from "../../lib/pluginManifest";
import type { MenuItem } from "../../platform/menus";
import { notePlugin } from "../telemetry/pluginCounts";
import type { ConsentToken } from "../telemetry/choice";
import { currentPlugins, type PluginsStore } from "./store";
import { manifestInProfile, windowProfileId } from "./profileScope";
import { activeNames } from "./store";
import { runPluginCommand, type CommandContext } from "./commands";

const PLUGIN_MENU_PREFIX = "plugin-menu:";
const SUBMENU_AFTER = 2;

export type PluginMenuContext = { when: WhenContext; data?: CommandContext };

const pluginMenuChoice = (slot: MenuSlot, plugin: string, command: string) => `${PLUGIN_MENU_PREFIX}${slot}/${plugin}/${command}`;
export const isPluginMenuChoice = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(PLUGIN_MENU_PREFIX);

const contextProfile = (context: PluginMenuContext) => (typeof context.data?.windowId === "string" ? windowProfileId(context.data.windowId) : null);

export function pluginMenuItems(slot: MenuSlot, context: PluginMenuContext, s: Pick<PluginsStore, "listings" | "records" | "order"> = currentPlugins()): MenuItem[] {
  const out: MenuItem[] = [];
  const profileId = contextProfile(context);
  for (const plugin of activeNames(s)) {
    const m = manifestInProfile(s, plugin, profileId);
    if (!m) continue;
    const items: MenuItem[] = m.contributes.menus[slot].flatMap((entry) => {
      const command = m.commands.find((c) => c.name === entry.command);
      if (!command || !whenHolds(entry.when, context.when) || !whenHolds(command.when, context.when)) return [];
      return [{ id: pluginMenuChoice(slot, plugin, command.name), title: entry.title ?? command.title, symbol: entry.icon ?? command.icon }];
    });
    if (items.length > SUBMENU_AFTER) out.push({ id: `${PLUGIN_MENU_PREFIX}${slot}/${plugin}`, title: m.title, symbol: m.icon ?? "puzzlepiece", children: items });
    else out.push(...items);
  }
  return out;
}

function parsePluginMenuChoice(choice: string): { slot: MenuSlot; plugin: string; command: string } | null {
  if (!isPluginMenuChoice(choice)) return null;
  const [slot, plugin, command, ...extra] = choice.slice(PLUGIN_MENU_PREFIX.length).split("/");
  return slot && plugin && command && !extra.length ? { slot: slot as MenuSlot, plugin, command } : null;
}

export async function runPluginMenuChoice(choice: string, windowId: string, context: PluginMenuContext, consent?: ConsentToken | null): Promise<boolean> {
  const parsed = parsePluginMenuChoice(choice);
  if (!parsed) return false;
  const m = manifestInProfile(currentPlugins(), parsed.plugin, windowProfileId(windowId));
  const entry = m?.contributes.menus[parsed.slot]?.find((e) => e.command === parsed.command);
  const command = m?.commands.find((c) => c.name === parsed.command);
  if (!entry || !command || !whenHolds(entry.when, context.when) || !whenHolds(command.when, context.when)) return false;
  notePlugin("plugin_menu_runs", consent);
  return runPluginCommand(parsed.plugin, parsed.command, windowId, { from: "menu", slot: parsed.slot, ...context.data }, context.when, consent);
}
