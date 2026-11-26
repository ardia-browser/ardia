import { ordered } from "./modifiers";
import { comboKey, resolveShortcuts, sameShortcut, storedShortcut, type ResolvedShortcuts, type Shortcut, type ShortcutOverrides, type ShortcutSource } from "./shortcuts";

export type CtrlTabKeys = "switcher" | "custom";
type CtrlTabCombos = { forward: Shortcut; backward: Shortcut };
type Pair = { forward: string; backward: string };

const TAB = "\t";
const SWITCHER: Pair = { forward: "tabSwitcher:forward", backward: "tabSwitcher:backward" };
const STEP: Pair = { forward: "nextTab", backward: "previousTab" };

type Defaults = Pick<ResolvedShortcuts, "defaultsOf">;
type Held = Pick<ResolvedShortcuts, "bindings" | "defaultsOf" | "holdersOf">;

const tabWithOneModifier = (k: Shortcut) => k.key === TAB && k.modifiers.length === 1 && k.modifiers[0] !== "shift";

export function ctrlTabCombos(resolved: Defaults): CtrlTabCombos | null {
  const forward = resolved.defaultsOf(SWITCHER.forward).find(tabWithOneModifier);
  return forward ? { forward, backward: { key: TAB, modifiers: ordered([...forward.modifiers, "shift"]) } } : null;
}

const holds = (resolved: Pick<ResolvedShortcuts, "bindings">, id: string, combo: Shortcut) => (resolved.bindings.get(id) ?? []).some((k) => sameShortcut(k, combo));

const heldOnlyBy = (resolved: Held, combo: Shortcut, id: string) => holds(resolved, id, combo) && resolved.holdersOf(combo).every((holder) => holder === id);

const pairHolds = (resolved: Held, combos: CtrlTabCombos, pair: Pair) => heldOnlyBy(resolved, combos.forward, pair.forward) && heldOnlyBy(resolved, combos.backward, pair.backward);

export function ctrlTabKeysOf(resolved: Held): CtrlTabKeys {
  const combos = ctrlTabCombos(resolved);
  return combos && pairHolds(resolved, combos, SWITCHER) ? "switcher" : "custom";
}

type CtrlTabCustomTarget = { combo: Shortcut } | { command: string };

export function ctrlTabCustomTarget(resolved: Held): CtrlTabCustomTarget | null {
  const combos = ctrlTabCombos(resolved);
  if (!combos) return null;
  const direction = heldOnlyBy(resolved, combos.forward, SWITCHER.forward) ? "backward" : "forward";
  const combo = combos[direction];
  return resolved.holdersOf(combo).length ? { combo } : { command: SWITCHER[direction] };
}

const stored = ({ key, modifiers }: Shortcut) => [key, ...modifiers];

const isOverride = (keys: readonly string[] | undefined, combo: Shortcut) => !!keys?.[0] && sameShortcut(storedShortcut(keys), combo);

export function ctrlTabOverrides(overrides: ShortcutOverrides, combos: CtrlTabCombos, defaultsOf: Defaults["defaultsOf"]): ShortcutOverrides {
  const taken = new Set([comboKey(combos.forward), comboKey(combos.backward)]);
  const next: ShortcutOverrides = {};
  for (const [id, keys] of Object.entries(overrides)) {
    if (keys[0] && taken.has(comboKey(storedShortcut(keys)))) continue;
    if (id === SWITCHER.forward || id === SWITCHER.backward) continue;
    next[id] = keys;
  }
  const owns = (id: string, combo: Shortcut) => defaultsOf(id).some((k) => sameShortcut(k, combo));
  if (!owns(SWITCHER.forward, combos.forward)) next[SWITCHER.forward] = stored(combos.forward);
  if (!owns(SWITCHER.backward, combos.backward)) next[SWITCHER.backward] = stored(combos.backward);
  return next;
}

export type CtrlTabUpgrade = { shortcuts: ShortcutOverrides; stepped: boolean };

function sourcesBeforeSwitcherDefault(sources: readonly ShortcutSource[], combos: CtrlTabCombos): ShortcutSource[] {
  const ctrlTab = (id: string) => (id === SWITCHER.forward ? combos.forward : id === SWITCHER.backward ? combos.backward : null);
  const stepTo = (id: string) => (id === STEP.forward ? combos.forward : id === STEP.backward ? combos.backward : null);
  return sources.map((source) => {
    const moved = ctrlTab(source.id);
    if (moved) return { ...source, keys: source.keys.filter((k) => !sameShortcut(k, moved)) };
    const added = stepTo(source.id);
    return added ? { ...source, keys: [...source.keys, added] } : source;
  });
}

function without(overrides: ShortcutOverrides, pair: Pair, combos: CtrlTabCombos): ShortcutOverrides {
  const dropped = [pair.forward, pair.backward].filter((id) => isOverride(overrides[id], id === pair.forward ? combos.forward : combos.backward));
  return dropped.length ? Object.fromEntries(Object.entries(overrides).filter(([id]) => !dropped.includes(id))) : overrides;
}

const boundToStep = (overrides: ShortcutOverrides, combos: CtrlTabCombos) => isOverride(overrides[STEP.forward], combos.forward) && isOverride(overrides[STEP.backward], combos.backward);

const DIRECTIONS = ["forward", "backward"] as const;

export function ctrlTabUpgrade(overrides: ShortcutOverrides, sources: readonly ShortcutSource[], { usedToStep }: { usedToStep: boolean }): CtrlTabUpgrade {
  const unchanged = { shortcuts: overrides, stepped: false };
  const combos = ctrlTabCombos(resolveShortcuts(sources, {}));
  if (!combos) return unchanged;
  const before = resolveShortcuts(usedToStep ? sourcesBeforeSwitcherDefault(sources, combos) : sources, overrides);
  const after = (candidate: ShortcutOverrides) => resolveShortcuts(sources, candidate);
  if (pairHolds(before, combos, SWITCHER)) {
    const shortcuts = without(overrides, SWITCHER, combos);
    return pairHolds(after(shortcuts), combos, SWITCHER) ? { shortcuts, stepped: false } : unchanged;
  }
  const stepping = DIRECTIONS.filter((d) => heldOnlyBy(before, combos[d], STEP[d]));
  if (!stepping.length) return unchanged;
  const switcherElsewhere = !!overrides[SWITCHER.forward]?.[0] || !!overrides[SWITCHER.backward]?.[0];
  if (stepping.length === 2 && !switcherElsewhere && boundToStep(overrides, combos)) {
    const shortcuts = without(overrides, STEP, combos);
    return pairHolds(after(shortcuts), combos, SWITCHER) ? { shortcuts, stepped: true } : unchanged;
  }
  const kept = (candidate: ShortcutOverrides, d: (typeof DIRECTIONS)[number]) =>
    switcherElsewhere ? heldOnlyBy(after(candidate), combos[d], STEP[d]) : after(candidate).holdersOf(combos[d]).length > 0;
  let shortcuts = overrides;
  for (const d of stepping) if (!kept(shortcuts, d)) shortcuts = { ...shortcuts, [STEP[d]]: stored(combos[d]) };
  return stepping.every((d) => kept(shortcuts, d)) ? { shortcuts, stepped: false } : unchanged;
}
