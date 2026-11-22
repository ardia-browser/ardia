import { create } from "zustand";
import type { InputBoxOptions, PluginNode, QuickPickItem, QuickPickOptions, SurfaceKind, ToolbarUpdate } from "../../lib/pluginProtocol";
import { notePlugin } from "../telemetry/pluginCounts";
import type { ConsentToken } from "../telemetry/choice";
import { useBrowser } from "../browser/store";
import { eligibleKind } from "../automation/automationWindows";
import { activeManifest, currentPlugins } from "./store";
import { ensurePluginActivated, onPluginReady, pluginReadyRun } from "./activation";
import { notePluginGesture } from "./gestures";
import { sendSurfaceMessage } from "./tools";

export type Anchor = { x: number; y: number; width: number; height: number };
export type SidePanel = { plugin: string; panelId: string; opened: number; generation: number; hidden?: boolean };
export type Popover = { plugin: string; itemId: string; viewId: string; anchor: Anchor };
export type CommandView = { plugin: string; command: string; viewId: string; title: string; icon: string };
export type QuickPickRequest = { id: string; plugin: string; windowId: string; items: QuickPickItem[]; options: QuickPickOptions };
export type InputBoxRequest = { id: string; plugin: string; windowId: string; options: InputBoxOptions };

export type PluginSurfacesStore = {
  trees: Record<string, PluginNode>;
  toolbarState: Record<string, ToolbarUpdate>;
  sidePanels: Record<string, SidePanel>;
  retainedSidePanels: Record<string, SidePanel[]>;
  popovers: Record<string, Popover>;
  commandViews: Record<string, CommandView>;
  quickPick: QuickPickRequest | null;
  inputBox: InputBoxRequest | null;
};

export const usePluginSurfaces = create<PluginSurfacesStore>()(() => ({
  trees: {},
  toolbarState: {},
  sidePanels: {},
  retainedSidePanels: {},
  popovers: {},
  commandViews: {},
  quickPick: null,
  inputBox: null,
}));

export const surfaceKey = (plugin: string, id: string) => `${plugin}:${id}`;

let instanceSeq = 0;
export const nextSurfaceInstanceId = (viewId: string): string => `${viewId}#${++instanceSeq}`;

export const isSurfaceWindowEligible = (windowId: string): boolean => !!eligibleKind(useBrowser.getState(), windowId);

type Mounted = { plugin: string; surfaceId: string; viewId: string; kind: SurfaceKind; windowId: string; context: Record<string, unknown>; sentRun: number | null };
const mounted = new Map<string, Mounted>();

const without = <T,>(record: Record<string, T>, keep: (value: T, key: string) => boolean): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([k, v]) => keep(v, k)));

export function setPluginSurfaceTree(plugin: string, surfaceId: string, tree: PluginNode) {
  usePluginSurfaces.setState((s) => ({ trees: { ...s.trees, [surfaceKey(plugin, surfaceId)]: tree } }));
  notePlugin("plugin_surface_renders");
}

export function updatePluginToolbar(plugin: string, itemId: string, update: ToolbarUpdate) {
  const key = surfaceKey(plugin, itemId);
  usePluginSurfaces.setState((s) => ({ toolbarState: { ...s.toolbarState, [key]: { ...s.toolbarState[key], ...update } } }));
}

function sendMount(m: Mounted): boolean {
  const run = pluginReadyRun(m.plugin);
  if (run === null) return false;
  if (m.sentRun === run) return true;
  const sent = sendSurfaceMessage(m.plugin, { surface: "mount", surfaceId: m.surfaceId, viewId: m.viewId, kind: m.kind, context: { windowId: m.windowId, ...m.context } });
  if (sent) m.sentRun = run;
  return sent;
}

export async function mountPluginSurface(plugin: string, surfaceId: string, kind: SurfaceKind, windowId: string, context: Record<string, unknown> = {}, viewId: string = surfaceId): Promise<boolean> {
  if (!isSurfaceWindowEligible(windowId)) return false;
  const key = surfaceKey(plugin, surfaceId);
  const entry: Mounted = { plugin, surfaceId, viewId, kind, windowId, context, sentRun: null };
  mounted.set(key, entry);
  try {
    await ensurePluginActivated(plugin, kind === "panel" ? `onPanel:${viewId}` : `onView:${viewId}`);
  } catch {
    return false;
  }
  return mounted.get(key) === entry && sendMount(entry);
}

export function unmountPluginSurface(plugin: string, surfaceId: string, windowId: string) {
  const key = surfaceKey(plugin, surfaceId);
  if (mounted.get(key)?.windowId !== windowId) return;
  mounted.delete(key);
  sendSurfaceMessage(plugin, { surface: "unmount", surfaceId });
  usePluginSurfaces.setState((s) => ({ trees: without(s.trees, (_v, k) => k !== key) }));
}

export function dispatchPluginSurfaceEvent(plugin: string, surfaceId: string, windowId: string, handlerId: string, args: unknown[] = [], options: { gesture?: boolean } = {}): boolean {
  if (typeof handlerId !== "string" || !handlerId || handlerId.length > 200) return false;
  if (!isSurfaceWindowEligible(windowId)) return false;
  if (options.gesture !== false) notePluginGesture(plugin, windowId);
  return sendSurfaceMessage(plugin, { surface: "event", surfaceId, handlerId, args: Array.isArray(args) ? args : [args] });
}

export const mountedSurfaces = (plugin: string) => [...mounted.values()].filter((m) => m.plugin === plugin);

export const isMountedSurface = (plugin: string, surfaceId: string) => mounted.has(surfaceKey(plugin, surfaceId));

export const mountedEntry = (plugin: string, surfaceId: string): { viewId: string; windowId: string; kind: SurfaceKind; context: Record<string, unknown> } | null => mounted.get(surfaceKey(plugin, surfaceId)) ?? null;

export const mountedInstancesOf = (plugin: string, viewId: string) => [...mounted.values()].filter((m) => m.plugin === plugin && m.viewId === viewId).map((m) => m.surfaceId);

const sidePanelKey = (panel: Pick<SidePanel, "plugin" | "panelId">) => surfaceKey(panel.plugin, panel.panelId);
const retainsContext = (plugin: string, panelId: string) => activeManifest(currentPlugins(), plugin)?.contributes.panels.find((p) => p.id === panelId)?.retainContext === true;

let panelGeneration = 0;

function livingGeneration(s: PluginSurfacesStore, windowId: string, key: string): number | null {
  const current = s.sidePanels[windowId];
  if (current && !current.hidden && sidePanelKey(current) === key) return current.generation;
  return (s.retainedSidePanels[windowId] ?? []).find((p) => sidePanelKey(p) === key)?.generation ?? null;
}

export function openPluginSidePanel(windowId: string, plugin: string, panelId: string, consent?: ConsentToken | null): boolean {
  if (!isSurfaceWindowEligible(windowId)) return false;
  const retain = retainsContext(plugin, panelId);
  usePluginSurfaces.setState((s) => {
    const panel: SidePanel = { plugin, panelId, opened: Date.now(), generation: livingGeneration(s, windowId, surfaceKey(plugin, panelId)) ?? ++panelGeneration };
    const kept = s.retainedSidePanels[windowId] ?? [];
    const retained = retain ? [...kept.filter((p) => sidePanelKey(p) !== sidePanelKey(panel)), panel] : kept;
    return { sidePanels: { ...s.sidePanels, [windowId]: panel }, retainedSidePanels: retain ? { ...s.retainedSidePanels, [windowId]: retained } : s.retainedSidePanels };
  });
  notePlugin("plugin_panel_opens", consent);
  return true;
}

export function closePluginSidePanel(windowId: string, plugin?: string) {
  usePluginSurfaces.setState((s) => {
    const current = s.sidePanels[windowId];
    if (!current || current.hidden || (plugin && current.plugin !== plugin)) return s;
    const retained = (s.retainedSidePanels[windowId] ?? []).some((p) => sidePanelKey(p) === sidePanelKey(current));
    return { sidePanels: retained ? { ...s.sidePanels, [windowId]: { ...current, hidden: true } } : without(s.sidePanels, (_v, k) => k !== windowId) };
  });
}

export function openPluginPopover(windowId: string, plugin: string, itemId: string, viewId: string, anchor: Anchor): boolean {
  if (!isSurfaceWindowEligible(windowId)) return false;
  usePluginSurfaces.setState((s) => ({ popovers: { ...s.popovers, [windowId]: { plugin, itemId, viewId, anchor } } }));
  return true;
}

export function closePluginPopover(windowId: string) {
  usePluginSurfaces.setState((s) => (s.popovers[windowId] ? { popovers: without(s.popovers, (_v, k) => k !== windowId) } : s));
}

export function openPluginCommandView(windowId: string, view: CommandView): boolean {
  if (!isSurfaceWindowEligible(windowId)) return false;
  usePluginSurfaces.setState((s) => ({ commandViews: { ...s.commandViews, [windowId]: view } }));
  return true;
}

export function closePluginCommandView(windowId: string) {
  usePluginSurfaces.setState((s) => (s.commandViews[windowId] ? { commandViews: without(s.commandViews, (_v, k) => k !== windowId) } : s));
}

type Answer<T> = { plugin: string; resolve: (value: T) => void };
const quickPickAnswers = new Map<string, Answer<string[] | null>>();
const inputBoxAnswers = new Map<string, Answer<string | null>>();
let promptSeq = 0;

export const PROMPT_BUSY = "Another plugin prompt is open.";

export function showPluginQuickPick(plugin: string, windowId: string, items: QuickPickItem[], options: QuickPickOptions): Promise<string[] | null> | null {
  if (usePluginSurfaces.getState().quickPick || usePluginSurfaces.getState().inputBox) return null;
  const id = `qp${++promptSeq}`;
  notePlugin("plugin_ui_prompts");
  return new Promise((resolve) => {
    quickPickAnswers.set(id, { plugin, resolve });
    usePluginSurfaces.setState({ quickPick: { id, plugin, windowId, items, options } });
  });
}

export function resolveQuickPick(id: string, picked: string[] | null) {
  const answer = quickPickAnswers.get(id);
  if (!answer) return;
  quickPickAnswers.delete(id);
  const request = usePluginSurfaces.getState().quickPick;
  const known = new Set(request?.id === id ? request.items.map((i) => i.id) : []);
  const chosen = picked === null ? null : picked.filter((p) => known.has(p));
  const single = request?.options.canPickMany ? chosen : (chosen?.slice(0, 1) ?? null);
  if (request?.id === id) usePluginSurfaces.setState({ quickPick: null });
  if (picked !== null) notePluginGesture(answer.plugin, request?.windowId ?? "");
  answer.resolve(single);
}

export function showPluginInputBox(plugin: string, windowId: string, options: InputBoxOptions): Promise<string | null> | null {
  if (usePluginSurfaces.getState().quickPick || usePluginSurfaces.getState().inputBox) return null;
  const id = `ib${++promptSeq}`;
  notePlugin("plugin_ui_prompts");
  return new Promise((resolve) => {
    inputBoxAnswers.set(id, { plugin, resolve });
    usePluginSurfaces.setState({ inputBox: { id, plugin, windowId, options } });
  });
}

export function resolveInputBox(id: string, value: string | null) {
  const answer = inputBoxAnswers.get(id);
  if (!answer) return;
  inputBoxAnswers.delete(id);
  const request = usePluginSurfaces.getState().inputBox;
  if (request?.id === id) usePluginSurfaces.setState({ inputBox: null });
  if (value !== null) notePluginGesture(answer.plugin, request?.windowId ?? "");
  answer.resolve(typeof value === "string" ? value.slice(0, 10_000) : null);
}

export function clearPluginSurfaces(plugin: string) {
  for (const [key, m] of mounted) if (m.plugin === plugin) mounted.delete(key);
  for (const [id, a] of quickPickAnswers) if (a.plugin === plugin) resolveQuickPick(id, null);
  for (const [id, a] of inputBoxAnswers) if (a.plugin === plugin) resolveInputBox(id, null);
  const prefix = `${plugin}:`;
  usePluginSurfaces.setState((s) => ({
    trees: without(s.trees, (_v, k) => !k.startsWith(prefix)),
    toolbarState: without(s.toolbarState, (_v, k) => !k.startsWith(prefix)),
    sidePanels: without(s.sidePanels, (v) => v.plugin !== plugin),
    retainedSidePanels: Object.fromEntries(Object.entries(s.retainedSidePanels).flatMap(([w, panels]) => {
      const kept = panels.filter((p) => p.plugin !== plugin);
      return kept.length ? [[w, kept]] : [];
    })),
    popovers: without(s.popovers, (v) => v.plugin !== plugin),
    commandViews: without(s.commandViews, (v) => v.plugin !== plugin),
  }));
}

export function dropHiddenRetainedSidePanels(plugin: string) {
  const s = usePluginSurfaces.getState();
  const dropped: { windowId: string; panelId: string }[] = [];
  const shownOf = (windowId: string) => {
    const current = s.sidePanels[windowId];
    return current && !current.hidden && current.plugin === plugin ? current.panelId : null;
  };
  const retainedSidePanels = Object.fromEntries(Object.entries(s.retainedSidePanels).flatMap(([w, panels]) => {
    const kept = panels.filter((p) => p.plugin !== plugin || p.panelId === shownOf(w));
    for (const p of panels) if (!kept.includes(p)) dropped.push({ windowId: w, panelId: p.panelId });
    return kept.length ? [[w, kept]] : [];
  }));
  const sidePanels = without(s.sidePanels, (v) => !(v.plugin === plugin && v.hidden));
  for (const [w, v] of Object.entries(s.sidePanels)) if (v.plugin === plugin && v.hidden && !dropped.some((d) => d.windowId === w && d.panelId === v.panelId)) dropped.push({ windowId: w, panelId: v.panelId });
  if (!dropped.length && Object.keys(sidePanels).length === Object.keys(s.sidePanels).length) return;
  const droppedTrees = new Set<string>();
  for (const [key, m] of mounted) {
    if (m.plugin !== plugin || m.kind !== "panel" || Object.hasOwn(m.context, "tabId")) continue;
    if (!dropped.some((d) => d.windowId === m.windowId && d.panelId === m.context.panelId)) continue;
    mounted.delete(key);
    droppedTrees.add(key);
  }
  usePluginSurfaces.setState((now) => ({ retainedSidePanels, sidePanels, trees: droppedTrees.size ? without(now.trees, (_v, k) => !droppedTrees.has(k)) : now.trees }));
}

export function dropWindowPluginSurfaces(windowId: string) {
  const { quickPick, inputBox } = usePluginSurfaces.getState();
  if (quickPick?.windowId === windowId) resolveQuickPick(quickPick.id, null);
  if (inputBox?.windowId === windowId) resolveInputBox(inputBox.id, null);
  const other = (_v: unknown, k: string) => k !== windowId;
  usePluginSurfaces.setState((s) => ({
    sidePanels: without(s.sidePanels, other),
    retainedSidePanels: without(s.retainedSidePanels, other),
    popovers: without(s.popovers, other),
    commandViews: without(s.commandViews, other),
  }));
}

let watching = false;
let stopWindowWatch: (() => void) | null = null;

const holdsWindowSurfaces = (s: PluginSurfacesStore) =>
  !!(s.quickPick || s.inputBox) || Object.keys(s.sidePanels).length > 0 || Object.keys(s.retainedSidePanels).length > 0 || Object.keys(s.popovers).length > 0 || Object.keys(s.commandViews).length > 0;

function syncWindowWatch(s: PluginSurfacesStore) {
  const wanted = holdsWindowSurfaces(s);
  if (wanted && !stopWindowWatch) {
    stopWindowWatch = useBrowser.subscribeTo(["windows"], (now, prev) => {
      for (const windowId of Object.keys(prev.windows)) if (!Object.hasOwn(now.windows, windowId) || (eligibleKind(prev, windowId) && !eligibleKind(now, windowId))) dropWindowPluginSurfaces(windowId);
    });
  } else if (!wanted && stopWindowWatch) {
    stopWindowWatch();
    stopWindowWatch = null;
  }
}

export const watchingSurfaceWindows = () => stopWindowWatch !== null;

export function watchSurfaceRemounts() {
  if (watching) return;
  watching = true;
  onPluginReady((plugin) => {
    for (const m of mountedSurfaces(plugin)) sendMount(m);
  });
  usePluginSurfaces.subscribe(syncWindowWatch);
  syncWindowWatch(usePluginSurfaces.getState());
}
