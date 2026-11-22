import { pagePanelOf, type PanelSpec, type PluginManifest } from "../../lib/pluginManifest";
import { notePlugin } from "../telemetry/pluginCounts";
import type { ConsentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins } from "./store";
import { ensurePluginActivated, pluginReadyRun } from "./activation";
import { openPluginPage, panelPath } from "./pages";
import { closePluginSidePanel, isSurfaceWindowEligible, openPluginSidePanel, usePluginSurfaces } from "./surfaces";
import { t } from "../../lib/uiLanguage";


export type PanelOutcome = { ok: true; tabId?: string } | { ok: false; reason: string };

const INELIGIBLE = t(`Plugins don't run in private windows.`);

export function pluginPanel(plugin: string, panelId: string): PanelSpec | null {
  return activeManifest(currentPlugins(), plugin)?.contributes.panels.find((p) => p.id === panelId) ?? null;
}

function wakeForFilePanel(plugin: string, m: PluginManifest, panel: PanelSpec) {
  if (m.main === null || !panel.file || pluginReadyRun(plugin) !== null) return;
  void ensurePluginActivated(plugin, `onPanel:${panel.id}`).catch(() => {});
}

export function openPluginPanel(windowId: string, plugin: string, panelId: string, consent?: ConsentToken | null): PanelOutcome {
  if (!isSurfaceWindowEligible(windowId)) return { ok: false, reason: INELIGIBLE };
  const m = activeManifest(currentPlugins(), plugin);
  const panel = m?.contributes.panels.find((p) => p.id === panelId);
  if (!m || !panel) return { ok: false, reason: `${plugin} has no panel ${panelId}.` };
  if (panel.mode === "sidecar") {
    if (!openPluginSidePanel(windowId, plugin, panelId, consent)) return { ok: false, reason: INELIGIBLE };
    wakeForFilePanel(plugin, m, panel);
    return { ok: true };
  }
  const path = pagePanelOf(m.contributes.panels)?.id === panel.id ? "" : panelPath(panel.id);
  const tabId = openPluginPage(windowId, plugin, { split: panel.mode === "split", side: panel.side, path, consent });
  if (!tabId) return { ok: false, reason: t(`The panel couldn't open.`) };
  notePlugin("plugin_panel_opens", consent);
  return { ok: true, tabId };
}

export function closePluginPanel(windowId: string, plugin: string, panelId: string): PanelOutcome {
  const side = usePluginSurfaces.getState().sidePanels[windowId];
  if (side && !side.hidden && side.plugin === plugin && side.panelId === panelId) {
    closePluginSidePanel(windowId, plugin);
    return { ok: true };
  }
  return { ok: false, reason: `${panelId} isn't open as a side panel in that window.` };
}
