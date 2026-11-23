import { ordered } from "./modifiers";
import { comboKey, sameShortcut, storedShortcut, type ResolvedShortcuts, type Shortcut, type ShortcutOverrides } from "./shortcuts";

export type CtrlTabPreset = "step" | "switcher";
export type CtrlTabChoice = CtrlTabPreset | "custom";
type CtrlTabCombos = { forward: Shortcut; backward: Shortcut };

const CTRL_TAB_PRESETS: readonly CtrlTabPreset[] = ["step", "switcher"];

const TAB = "\t";
const PRESET_COMMANDS: Readonly<Record<CtrlTabPreset, { forward: string; backward: string }>> = {
  step: { forward: "nextTab", backward: "previousTab" },
  switcher: { forward: "tabSwitcher:forward", backward: "tabSwitcher:backward" },
};

type Defaults = Pick<ResolvedShortcuts, "defaultsOf">;
type Held = Pick<ResolvedShortcuts, "bindings" | "defaultsOf" | "holdersOf">;

const tabWithOneModifier = (k: Shortcut) => k.key === TAB && k.modifiers.length === 1 && k.modifiers[0] !== "shift";

export function ctrlTabCombos(resolved: Defaults): CtrlTabCombos | null {
  for (const preset of CTRL_TAB_PRESETS) {
    const forward = resolved.defaultsOf(PRESET_COMMANDS[preset].forward).find(tabWithOneModifier);
    if (forward) return { forward, backward: { key: TAB, modifiers: ordered([...forward.modifiers, "shift"]) } };
  }
  return null;
}

const holds = (resolved: Pick<ResolvedShortcuts, "bindings">, id: string, combo: Shortcut) => (resolved.bindings.get(id) ?? []).some((k) => sameShortcut(k, combo));

const heldOnlyBy = (resolved: Held, combo: Shortcut, id: string) => holds(resolved, id, combo) && resolved.holdersOf(combo).every((holder) => holder === id);

export function ctrlTabChoiceOf(resolved: Held): CtrlTabChoice {
  const combos = ctrlTabCombos(resolved);
  if (!combos) return "custom";
  for (const preset of CTRL_TAB_PRESETS) {
    const { forward, backward } = PRESET_COMMANDS[preset];
    if (heldOnlyBy(resolved, combos.forward, forward) && heldOnlyBy(resolved, combos.backward, backward)) return preset;
  }
  return "custom";
}

type CtrlTabCustomTarget = { combo: Shortcut } | { command: string };

export function ctrlTabCustomTarget(resolved: Held): CtrlTabCustomTarget | null {
  const combos = ctrlTabCombos(resolved);
  if (!combos) return null;
  const looksPicked = (combo: Shortcut, direction: "forward" | "backward") => CTRL_TAB_PRESETS.some((preset) => heldOnlyBy(resolved, combo, PRESET_COMMANDS[preset][direction]));
  const direction = looksPicked(combos.forward, "forward") ? "backward" : "forward";
  const combo = combos[direction];
  if (resolved.holdersOf(combo).length) return { combo };
  const owner = CTRL_TAB_PRESETS.map((preset) => PRESET_COMMANDS[preset][direction]).find((id) => resolved.defaultsOf(id).some((k) => sameShortcut(k, combo)));
  return owner ? { command: owner } : { combo };
}

const stored = ({ key, modifiers }: Shortcut) => [key, ...modifiers];

export function ctrlTabOverrides(overrides: ShortcutOverrides, combos: CtrlTabCombos, preset: CtrlTabPreset, defaultsOf: Defaults["defaultsOf"]): ShortcutOverrides {
  const target = PRESET_COMMANDS[preset];
  const taken = new Set([comboKey(combos.forward), comboKey(combos.backward)]);
  const next: ShortcutOverrides = {};
  for (const [id, keys] of Object.entries(overrides)) {
    if (keys[0] && taken.has(comboKey(storedShortcut(keys)))) continue;
    if (id === target.forward || id === target.backward) continue;
    next[id] = keys;
  }
  const owns = (id: string, combo: Shortcut) => defaultsOf(id).some((k) => sameShortcut(k, combo));
  if (!owns(target.forward, combos.forward)) next[target.forward] = stored(combos.forward);
  if (!owns(target.backward, combos.backward)) next[target.backward] = stored(combos.backward);
  return next;
}
