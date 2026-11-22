import type { ToolbarItem } from "../../lib/pluginManifest";
import type { ToolbarUpdate } from "../../lib/pluginProtocol";
import { notePlugin } from "../telemetry/pluginCounts";
import { activeManifest, activeNames, currentPlugins, type PluginsStore } from "./store";
import { runPluginCommand } from "./commands";
import { notePluginGesture } from "./gestures";
import { closePluginPopover, isSurfaceWindowEligible, openPluginPopover, surfaceKey, usePluginSurfaces, type Anchor, type PluginSurfacesStore } from "./surfaces";

export type PluginToolbarEntry = ToolbarItem & { plugin: string; key: string; state: ToolbarUpdate };

export function pluginToolbarItems(s: Pick<PluginsStore, "listings" | "records" | "order">, surfaces: Pick<PluginSurfacesStore, "toolbarState"> = usePluginSurfaces.getState()): PluginToolbarEntry[] {
  return activeNames(s).flatMap((plugin) =>
    activeManifest(s, plugin)!.contributes.toolbar.map((item) => {
      const key = surfaceKey(plugin, item.id);
      return { ...item, plugin, key, state: surfaces.toolbarState[key] ?? {} };
    }),
  );
}

export async function runPluginToolbarItem(windowId: string, plugin: string, itemId: string, anchor: Anchor): Promise<boolean> {
  if (!isSurfaceWindowEligible(windowId)) return false;
  const item = activeManifest(currentPlugins(), plugin)?.contributes.toolbar.find((t) => t.id === itemId);
  if (!item) return false;
  notePlugin("plugin_toolbar_runs");
  notePluginGesture(plugin, windowId);
  if (item.command) return runPluginCommand(plugin, item.command, windowId, { from: "toolbar", itemId });
  const open = usePluginSurfaces.getState().popovers[windowId];
  if (open?.plugin === plugin && open.itemId === itemId) {
    closePluginPopover(windowId);
    return true;
  }
  return openPluginPopover(windowId, plugin, itemId, item.view!, anchor);
}
