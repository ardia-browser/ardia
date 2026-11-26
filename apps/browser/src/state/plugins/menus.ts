import { whenHolds, type WhenContext } from "../../lib/pluginWhen";
import type { MenuSlot } from "../../lib/pluginManifest";
import type { MenuItem } from "../../platform/menus";
import { notePlugin } from "../telemetry/pluginCounts";
import type { ConsentToken } from "../telemetry/choice";
import { currentPlugins, type PluginsStore } from "./store";
import { manifestInProfile, windowProfileId } from "./profileScope";
import { activeNames } from "./store";
import { runPluginCommand, type CommandContext } from "./commands";
import { urlParts } from "../../lib/urlParts";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile, viewTabIds } from "../browser/model";
import { groupOf } from "../pins/tabGrouping";
import { splitOf } from "../splits/splits";
import { webviews } from "../../platform/webviews";

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

const PAGE_MENU_LIMIT = 8;

function pageMenuContext(tabId: string, s: BrowserState = useBrowser.getState()): { windowId: string; profileId: string; url: string; context: PluginMenuContext } | null {
  const tab = s.tabs[tabId];
  if (!tab || isIncognitoProfile(tab.profileId) || !/^https?:/i.test(tab.url)) return null;
  const parts = urlParts(tab.url);
  const when: WhenContext = {
    urlHost: parts?.host ?? "",
    urlScheme: parts?.scheme ?? "",
    isPinned: !!tab.pin,
    isInGroup: !!groupOf(s, tab.id),
    isSplit: !!splitOf(s, tab.id),
    isActive: activeTabId(s, tab.windowId) === tab.id,
    tabCount: viewTabIds(s, tab.windowId).length,
  };
  return { windowId: tab.windowId, profileId: tab.profileId, url: tab.url, context: { when, data: { tabId, windowId: tab.windowId } } };
}

export function pageMenuKey(s: BrowserState, tabId: string): string {
  const found = pageMenuContext(tabId, s);
  return found ? JSON.stringify([found.url, found.profileId, found.windowId, found.context.when]) : "";
}

const documentOf = (tabId: string) => webviews.get(tabId)?.pluginDocument().catch(() => null) ?? Promise.resolve(null);

export type PluginPageMenuItem = { id: `plugin-menu:${string}`; title: string; slot: "page" | "selection" };

export function pluginPageMenuItems(tabId: string, s: Pick<PluginsStore, "listings" | "records" | "order"> = currentPlugins()): PluginPageMenuItem[] {
  const found = pageMenuContext(tabId);
  if (!found) return [];
  type Entry = { id: string; title: string; children?: MenuItem[] };
  const flat = (items: MenuItem[]): Entry[] => items.flatMap((item) => ("separator" in item ? [] : (item as Entry).children ? flat((item as Entry).children!) : [item as Entry]));
  return (["page", "selection"] as const).flatMap((slot) =>
    flat(pluginMenuItems(slot, found.context, s))
      .slice(0, PAGE_MENU_LIMIT)
      .flatMap((item) => (isPluginMenuChoice(item.id) && item.title ? [{ id: item.id as `plugin-menu:${string}`, title: item.title, slot }] : [])),
  );
}

export async function runPluginPageMenu(tabId: string, choice: string, text: string, document: string, consent?: ConsentToken | null): Promise<boolean> {
  const found = pageMenuContext(tabId);
  if (!found || !document) return false;
  const now = await documentOf(tabId);
  const again = pageMenuContext(tabId);
  if (now !== document || !again || again.profileId !== found.profileId || again.url !== found.url) return false;
  if (choice.startsWith(`${PLUGIN_MENU_PREFIX}page/`)) return runPluginMenuChoice(choice, again.windowId, again.context, consent);
  if (!choice.startsWith(`${PLUGIN_MENU_PREFIX}selection/`) || !text.trim()) return false;
  return runPluginMenuChoice(choice, again.windowId, { when: again.context.when, data: { ...again.context.data, selection: text.slice(0, 20_000) } }, consent);
}
