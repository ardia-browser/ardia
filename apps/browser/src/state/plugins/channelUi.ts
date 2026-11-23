import { isFields } from "../../lib/decode";
import { viewIdsOf, type PluginManifest } from "../../lib/pluginManifest";
import { checkPluginNode, inputBoxOptionsOf, quickPickItemsOf, quickPickOptionsOf, toolbarUpdateOf } from "../../lib/pluginNodes";
import { confirm } from "../../platform/dialogs";
import { useBrowser } from "../browser/store";
import { showToast } from "../app/toasts";
import { failure } from "../automation/automationMethods";
import { eligibleKind, lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { recentPluginGesture } from "./gestures";
import { closePluginCommandView, closePluginPopover, closePluginSidePanel, isMountedSurface, mountedEntry, mountedInstancesOf, PROMPT_BUSY, setPluginSurfaceTree, showPluginInputBox, showPluginQuickPick, updatePluginToolbar, usePluginSurfaces } from "./surfaces";
import { closePluginPanel, openPluginPanel, pluginPanel } from "./panels";

const TOAST_GAP_MS = 1500;
const SYMBOL = /^[a-z0-9.]{1,64}$/;

type Caller = { name: string; run: number };

const lastToast = new Map<string, number>();
const confirming = new Set<string>();

function windowFor(plugin: string, given: unknown): string | null {
  const s = useBrowser.getState();
  if (typeof given === "string") return eligibleKind(s, given) ? given : null;
  const gesture = recentPluginGesture(plugin);
  if (gesture && eligibleKind(s, gesture.windowId)) return gesture.windowId;
  return lastFocusedEligibleWindow(s);
}

const textOf = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.slice(0, max) : null);

async function quickPick(c: Caller, params: Record<string, unknown>): Promise<Body> {
  const items = quickPickItemsOf(params.items);
  if (!items) return failure("bad_request", "items is a list of up to 500 { id, title } with unique ids.");
  const windowId = windowFor(c.name, params.windowId);
  if (!windowId) return failure("no_window", "No window to ask in.");
  const asked = showPluginQuickPick(c.name, windowId, items, quickPickOptionsOf(params.options));
  if (!asked) return failure("failed", PROMPT_BUSY);
  return { result: { picked: await asked } };
}

async function inputBox(c: Caller, params: Record<string, unknown>): Promise<Body> {
  const options = inputBoxOptionsOf(params.options ?? params);
  if (!options) return failure("bad_request", "showInputBox needs a title.");
  const windowId = windowFor(c.name, params.windowId);
  if (!windowId) return failure("no_window", "No window to ask in.");
  const asked = showPluginInputBox(c.name, windowId, options);
  if (!asked) return failure("failed", PROMPT_BUSY);
  return { result: { value: await asked } };
}

async function confirmBox(c: Caller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const options = isFields(params.options) ? params.options : params;
  const title = textOf(options.title, 120);
  if (!title) return failure("bad_request", "showConfirm needs a title.");
  if (confirming.has(c.name)) return failure("failed", PROMPT_BUSY);
  const windowId = windowFor(c.name, params.windowId);
  if (!windowId) return failure("no_window", "No window to ask in.");
  confirming.add(c.name);
  notePlugin("plugin_ui_prompts");
  try {
    const message = textOf(options.message, 600);
    const answer = await confirm({
      title: `${m.title}: ${title}`,
      ...(message ? { message } : {}),
      ...(textOf(options.confirmTitle, 30) ? { confirmTitle: textOf(options.confirmTitle, 30)! } : {}),
      ...(options.destructive === true ? { destructive: true } : {}),
      windowId,
      sheetOnly: true,
    });
    if (answer.unavailable === true) return failure("no_window", "No visible window to show the dialog.");
    return { result: { confirmed: answer.confirmed === true } };
  } finally {
    confirming.delete(c.name);
  }
}

function toast(c: Caller, params: Record<string, unknown>): Body {
  const title = textOf(params.title, 120);
  if (!title) return failure("bad_request", "showToast needs a title.");
  const now = Date.now();
  if (now - (lastToast.get(c.name) ?? 0) < TOAST_GAP_MS) return failure("failed", "Toasts from one plugin come at most every 1.5 s.");
  const windowId = windowFor(c.name, params.windowId);
  if (!windowId) return failure("no_window", "No window to show it in.");
  lastToast.set(c.name, now);
  const options = isFields(params.options) ? params.options : {};
  const icon = typeof options.icon === "string" && SYMBOL.test(options.icon) ? options.icon : "puzzlepiece";
  showToast(windowId, title, textOf(params.message, 300) ?? textOf(params.detail, 300) ?? textOf(options.message, 300) ?? undefined, { icon });
  return { result: { ok: true } };
}

function renderTargets(m: PluginManifest, plugin: string, surfaceId: string): string[] {
  if (isMountedSurface(plugin, surfaceId)) return [surfaceId];
  return viewIdsOf(m.contributes).includes(surfaceId) ? mountedInstancesOf(plugin, surfaceId) : [];
}

function render(m: PluginManifest, c: Caller, params: Record<string, unknown>): Body {
  const surfaceId = params.surfaceId;
  const targets = typeof surfaceId === "string" ? renderTargets(m, c.name, surfaceId) : [];
  if (!targets.length) return failure("refused", `This plugin has no open surface ${String(surfaceId).slice(0, 40)}.`);
  const checked = checkPluginNode(params.tree);
  if (!checked.ok) return failure("bad_request", `tree ${checked.problem}.`);
  for (const target of targets) setPluginSurfaceTree(c.name, target, checked.tree);
  return { result: { ok: true } };
}

const sideViewOf = (plugin: string, panelId: string) => {
  const spec = pluginPanel(plugin, panelId);
  return spec ? { id: spec.id, view: spec.view ?? spec.id } : null;
};

function closeInstance(plugin: string, instance: { viewId: string; windowId: string; kind: string; context: Record<string, unknown> }): number {
  const s = usePluginSurfaces.getState();
  const w = instance.windowId;
  const view = s.commandViews[w];
  const popover = s.popovers[w];
  const side = s.sidePanels[w];
  const panelId = typeof instance.context.panelId === "string" ? instance.context.panelId : null;
  const close =
    instance.kind === "command" && view?.plugin === plugin && view.viewId === instance.viewId
      ? () => closePluginCommandView(w)
      : instance.kind === "popover" && popover?.plugin === plugin && popover.viewId === instance.viewId
        ? () => closePluginPopover(w)
        : instance.kind === "panel" && side?.plugin === plugin && !side.hidden && panelId !== null && side.panelId === panelId
          ? () => closePluginSidePanel(w, plugin)
          : null;
  close?.();
  return close ? 1 : 0;
}

function closeSurface(c: Caller, params: Record<string, unknown>): Body {
  const surfaceId = params.surfaceId;
  if (typeof surfaceId !== "string") return failure("bad_request", "surface.close needs a surfaceId.");
  const instance = mountedEntry(c.name, surfaceId);
  if (instance) return { result: { ok: true, closed: closeInstance(c.name, instance) } };
  const s = usePluginSurfaces.getState();
  const mine = <T extends { plugin: string }>(byWindow: Record<string, T>, shows: (v: T) => boolean) => Object.keys(byWindow).filter((w) => byWindow[w]!.plugin === c.name && shows(byWindow[w]!));
  const views = mine(s.commandViews, (v) => v.viewId === surfaceId);
  const popovers = mine(s.popovers, (p) => p.viewId === surfaceId);
  const sides = mine(s.sidePanels, (side) => {
    const spec = sideViewOf(c.name, side.panelId);
    return !side.hidden && !!spec && (spec.view === surfaceId || spec.id === surfaceId);
  });
  views.forEach(closePluginCommandView);
  popovers.forEach(closePluginPopover);
  sides.forEach((w) => closePluginSidePanel(w, c.name));
  return { result: { ok: true, closed: views.length + popovers.length + sides.length } };
}

function toolbar(m: PluginManifest, c: Caller, params: Record<string, unknown>): Body {
  const itemId = params.itemId;
  if (typeof itemId !== "string" || !m.contributes.toolbar.some((t) => t.id === itemId)) return failure("refused", `This plugin declares no toolbar item ${String(itemId).slice(0, 40)}.`);
  const update = toolbarUpdateOf(params.update);
  if (!update) return failure("bad_request", "update takes icon, label, badge, tooltip and tone.");
  updatePluginToolbar(c.name, itemId, update);
  return { result: { ok: true } };
}

function panel(c: Caller, method: string, params: Record<string, unknown>): Body {
  if (typeof params.panelId !== "string") return failure("bad_request", `${method} needs a panelId.`);
  const windowId = windowFor(c.name, params.windowId);
  if (!windowId) return failure("no_window", "No window for the panel.");
  const outcome = method === "panel.open" ? openPluginPanel(windowId, c.name, params.panelId) : closePluginPanel(windowId, c.name, params.panelId);
  return outcome.ok ? { result: { ok: true, windowId, ...(outcome.tabId ? { tabId: outcome.tabId } : {}) } } : failure("failed", outcome.reason);
}

export const UI_METHODS = ["ui.showQuickPick", "ui.showInputBox", "ui.showConfirm", "ui.showToast", "surface.render", "surface.close", "toolbar.update", "panel.open", "panel.close"] as const;

export function uiMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  switch (method) {
    case "ui.showQuickPick":
      return quickPick(c, params);
    case "ui.showInputBox":
      return inputBox(c, params);
    case "ui.showConfirm":
      return confirmBox(c, m, params);
    case "ui.showToast":
      return toast(c, params);
    case "surface.render":
      return render(m, c, params);
    case "surface.close":
      return closeSurface(c, params);
    case "toolbar.update":
      return toolbar(m, c, params);
  }
  return panel(c, method, params);
}
