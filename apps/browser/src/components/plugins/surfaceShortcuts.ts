import { createContext, useContext, useEffect, useId, useMemo } from "react";
import type { PluginNode } from "../../lib/pluginProtocol";
import {
  bindingsOf,
  mergeShortcutBindings,
  pluginShortcutKeyChar,
  pluginShortcutModifiers,
  type PluginShortcut,
  type ShortcutBinding,
  type ShortcutHandledKey,
  type ShortcutKeyEvent,
} from "../../lib/pluginShortcuts";
import { commandsHolding } from "../../state/commands/commandShortcuts";
import { storedModifiers } from "../../state/commands/keyNotation";
import { formatShortcut, type Shortcut } from "../../state/commands/shortcuts";

export type SurfaceKeys = { keys: readonly ShortcutHandledKey[]; press: (e: ShortcutKeyEvent) => boolean };

export type ShortcutScope = SurfaceKeys & {
  depth: number;
  register: (id: string, depth: number, bindings: readonly ShortcutBinding<PluginNode>[] | null) => void;
};

export const NO_SURFACE_KEYS: SurfaceKeys = { keys: [], press: () => false };

export const ShortcutScopeContext = createContext<ShortcutScope>({ ...NO_SURFACE_KEYS, depth: 0, register: () => {} });

export const useSurfaceKeys = (): SurfaceKeys => useContext(ShortcutScopeContext);

export function useDeeperShortcutScope(): ShortcutScope {
  const scope = useContext(ShortcutScopeContext);
  return useMemo(() => ({ ...scope, depth: scope.depth + 1 }), [scope]);
}

export function useShortcutRegistration(actions: readonly PluginNode[]) {
  const { register, depth } = useContext(ShortcutScopeContext);
  const id = useId();
  const bindings = useMemo(() => bindingsOf(actions), [actions]);
  useEffect(() => register(id, depth, bindings), [register, id, depth, bindings]);
  useEffect(() => () => register(id, 0, null), [register, id]);
}

export const ardiaShortcutOf = (s: PluginShortcut): Shortcut => ({ key: pluginShortcutKeyChar(s), modifiers: storedModifiers(pluginShortcutModifiers(s)) });

export const heldByArdia = (s: PluginShortcut): boolean => commandsHolding(ardiaShortcutOf(s)).length > 0;

export function panelShortcuts(actions: readonly PluginNode[]): ReadonlyMap<PluginNode, PluginShortcut> {
  const merged = mergeShortcutBindings([{ depth: 0, seq: 0, bindings: bindingsOf(actions) }], heldByArdia);
  return new Map(merged.map((b) => [b.action, b.shortcut]));
}

export const shortcutHint = (s: PluginShortcut | undefined): string | undefined => (s ? formatShortcut(ardiaShortcutOf(s)) : undefined);

type MenuModifier = "command" | "shift" | "option" | "control";

export function menuKeyOf(s: PluginShortcut | undefined): { key?: string; modifiers?: MenuModifier[] } {
  if (!s) return {};
  const shortcut = ardiaShortcutOf(s);
  return { key: shortcut.key, modifiers: shortcut.modifiers.filter((m): m is MenuModifier => m !== "function") };
}
