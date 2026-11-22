import type { MenuItem } from "../../platform/menus";
import type { MenuShortcut } from "../../platform/commands";
import { useMemo } from "react";
import { create } from "zustand";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser } from "../browser/store";
import { ALL, useKeyed } from "../browser/keyedWatch";
import { commandTitle, shortcutSources, UNAVAILABLE_COMMANDS } from "./commandCatalog";
import type { BrowserCommand } from "../../platform/commands";
import { ALTERNATE_MODIFIER } from "./keyNotation";
import { formatShortcut, resolveShortcuts, type ResolvedShortcuts, type Shortcut, type ShortcutOverrides, type ShortcutSource } from "./shortcuts";
import { noteSettingsPick } from "../telemetry/settingsPickerCounts";
import { ctrlTabChoiceOf, ctrlTabCombos, ctrlTabCustomTarget, ctrlTabOverrides, type CtrlTabChoice, type CtrlTabPreset } from "./ctrlTabKeys";

export { cancelShortcutRecording, recordShortcut, type MenuShortcut } from "../../platform/commands";

type MenuModifier = NonNullable<Extract<MenuItem, { id: string }>["modifiers"]>[number];
type MenuKey = { key?: string; modifiers?: MenuModifier[] };
type ShortcutState = { settings: { shortcuts: ShortcutOverrides; mouseShortcuts?: ShortcutOverrides }; profileOrder: readonly string[] };
type MenuBar = { listed: ReadonlySet<string>; fixed: readonly ShortcutSource[] };

const useMenuBar = create<{ bar: MenuBar | undefined; revision: number }>()(() => ({ bar: undefined, revision: 0 }));
let resolvedFor: { overrides: ShortcutOverrides; mouse: ShortcutOverrides | undefined; profiles: readonly string[]; menuBar: MenuBar | undefined; resolved: ResolvedShortcuts } | undefined;

export function setMenuBarShortcuts(offered: readonly MenuShortcut[]) {
  const items = offered.filter((item) => !UNAVAILABLE_COMMANDS.has(item.id));
  const fixed = items.flatMap((item): ShortcutSource[] =>
    item.remappable ? [] : [{ id: item.id, fixed: true, keys: [{ key: item.key, modifiers: item.modifiers }] }],
  );
  const bar = { listed: new Set(items.map((item) => item.id)), fixed };
  useMenuBar.setState((m) => ({ bar, revision: m.revision + 1 }));
}

export const menuBarRevision = () => useMenuBar.getState().revision;
export const useMenuBarRevision = () => useMenuBar((m) => m.revision);

export function resolvedShortcuts({ settings, profileOrder }: ShortcutState): ResolvedShortcuts {
  const overrides = settings.shortcuts;
  const mouse = PLATFORM_FEATURES.mouseShortcuts ? settings.mouseShortcuts : undefined;
  const bar = useMenuBar.getState().bar;
  if (resolvedFor?.overrides !== overrides || resolvedFor.mouse !== mouse || resolvedFor.profiles !== profileOrder || resolvedFor.menuBar !== bar) {
    const catalog = shortcutSources(profileOrder, [...Object.keys(overrides), ...Object.keys(mouse ?? {})]);
    const sources = bar ? [...catalog.filter((source) => bar.listed.has(source.id)), ...bar.fixed] : catalog;
    resolvedFor = { overrides, mouse, profiles: profileOrder, menuBar: bar, resolved: resolveShortcuts(sources, overrides, undefined, mouse) };
  }
  return resolvedFor.resolved;
}

export const shortcutOf = (id: string, s: ShortcutState = useBrowser.getState()): Shortcut | undefined => resolvedShortcuts(s).bindings.get(id)?.[0];

export const commandsHolding = (shortcut: Shortcut, s: ShortcutState = useBrowser.getState()): string[] => resolvedShortcuts(s).holdersOf(shortcut);

export function shortcutHint(id: string, s: ShortcutState = useBrowser.getState()): string | undefined {
  const shortcut = shortcutOf(id, s);
  return shortcut && formatShortcut(shortcut);
}

export function menuShortcut(id: string, s: ShortcutState = useBrowser.getState()): MenuKey {
  const shortcut = shortcutOf(id, s);
  if (!shortcut || shortcut.modifiers.includes("function")) return {};
  return { key: shortcut.key, modifiers: shortcut.modifiers.filter((m): m is MenuModifier => m !== "function") };
}

function commandAlternateOf(id: string, s: ShortcutState): Shortcut | null {
  const primary = shortcutOf(id, s);
  const modifiers = primary?.modifiers ?? [];
  if (modifiers.includes(ALTERNATE_MODIFIER)) return null;
  const alternate: Shortcut = { key: primary?.key ?? "", modifiers: [...modifiers, ALTERNATE_MODIFIER] };
  if (alternate.key && resolvedShortcuts(s).holdersOf(alternate).length) return null;
  return alternate;
}

export function menuCommandAlternate(id: string, s: ShortcutState = useBrowser.getState()): MenuKey | null {
  const alternate = commandAlternateOf(id, s);
  if (!alternate) return null;
  if (!alternate.key || alternate.modifiers.includes("function")) return { modifiers: [ALTERNATE_MODIFIER] };
  return { key: alternate.key, modifiers: alternate.modifiers.filter((m): m is MenuModifier => m !== "function") };
}

const menuBarBindingsOf = new WeakMap<ResolvedShortcuts, Record<string, string[][]>>();
const stored = ({ key, modifiers }: Shortcut) => [key, ...modifiers];

export function menuBarBindings(s: ShortcutState): Record<string, string[][]> {
  const resolved = resolvedShortcuts(s);
  const cached = menuBarBindingsOf.get(resolved);
  if (cached) return cached;
  const fixed = new Set(useMenuBar.getState().bar?.fixed.map((source) => source.id));
  const bindings: Record<string, string[][]> = {};
  for (const [id, keys] of resolved.bindings) if (!fixed.has(id)) bindings[id] = keys.map(stored);
  for (const id of s.profileOrder) {
    const alternate = commandAlternateOf(`switchProfile:${id}`, s);
    bindings[`newWindow:${id}`] = alternate ? [stored(alternate)] : [];
  }
  menuBarBindingsOf.set(resolved, bindings);
  return bindings;
}

const menuBarMouseBindingsOf = new WeakMap<ResolvedShortcuts, Record<string, string[]>>();

export function menuBarMouseBindings(s: ShortcutState): Record<string, string[]> {
  const resolved = resolvedShortcuts(s);
  const cached = menuBarMouseBindingsOf.get(resolved);
  if (cached) return cached;
  const bindings: Record<string, string[]> = {};
  for (const [id, button] of resolved.mouse) if (resolved.holdersOf(button)[0] === id) bindings[id] = stored(button);
  menuBarMouseBindingsOf.set(resolved, bindings);
  return bindings;
}

export function withShortcut(title: string, hint: string | undefined): string {
  return hint ? `${title} (${hint})` : title;
}

export function useShortcutHint(id: string): string | undefined {
  useMenuBar(() => shortcutHint(id));
  return useKeyed(watchShortcuts, ALL, () => shortcutHint(id));
}

const shortcutListeners = new Set<() => void>();
let hearingShortcuts = false;

function watchShortcuts(_key: string, listener: () => void): () => void {
  if (!hearingShortcuts) {
    hearingShortcuts = true;
    useBrowser.subscribeTo(["settings", "profileOrder"], (s, prev) => {
      if (s.settings.shortcuts === prev.settings.shortcuts && s.profileOrder === prev.profileOrder) return;
      for (const heard of [...shortcutListeners]) heard();
    });
  }
  shortcutListeners.add(listener);
  return () => void shortcutListeners.delete(listener);
}

export const ctrlTabChoice = (s: ShortcutState = useBrowser.getState()): CtrlTabChoice => ctrlTabChoiceOf(resolvedShortcuts(s));

export function setCtrlTab(preset: CtrlTabPreset): boolean {
  const s = useBrowser.getState();
  const combos = ctrlTabCombos(resolvedShortcuts(s));
  if (!combos) return false;
  s.updateSettings({ shortcuts: ctrlTabOverrides(s.settings.shortcuts, combos, preset, resolvedShortcuts(s).defaultsOf) });
  return true;
}

export function chooseCtrlTab(preset: CtrlTabPreset) {
  if (setCtrlTab(preset)) noteSettingsPick("ctrlTab", preset);
}

export function ctrlTabCustomQuery(s: ShortcutState = useBrowser.getState()): string {
  const target = ctrlTabCustomTarget(resolvedShortcuts(s));
  if (!target) return "";
  if ("combo" in target) return formatShortcut(target.combo);
  const [command, arg] = target.command.split(":") as [BrowserCommand, string | undefined];
  return commandTitle(command, arg) ?? "";
}

export function useCtrlTabChoice(): CtrlTabChoice {
  useMenuBar(() => ctrlTabChoice());
  return useKeyed(watchShortcuts, ALL, () => ctrlTabChoice());
}

export function useShortcutAssignments(): readonly unknown[] {
  const bar = useMenuBarRevision();
  const shortcuts = useKeyed(watchShortcuts, ALL, () => useBrowser.getState().settings.shortcuts);
  const profiles = useKeyed(watchShortcuts, ALL, () => useBrowser.getState().profileOrder);
  return useMemo(() => [bar, shortcuts, profiles], [bar, shortcuts, profiles]);
}

const HINT_SEPARATOR = "\u0000";
const joinedHints = (ids: readonly string[], s?: ShortcutState) => ids.map((id) => shortcutHint(id, s) ?? "").join(HINT_SEPARATOR);

export function useShortcutHints<K extends string>(ids: readonly K[]): Readonly<Record<K, string | undefined>> {
  useMenuBar(() => joinedHints(ids));
  const joined = useKeyed(watchShortcuts, ALL, () => joinedHints(ids));
  return useMemo(() => {
    const hints = joined.split(HINT_SEPARATOR);
    return Object.fromEntries(ids.map((id, i) => [id, hints[i] || undefined])) as Record<K, string | undefined>;
  }, [joined]);
}

export const NAV_HINTS = ["back", "forward", "reload"] as const;
export type NavHints = Readonly<Record<(typeof NAV_HINTS)[number], string | undefined>>;
