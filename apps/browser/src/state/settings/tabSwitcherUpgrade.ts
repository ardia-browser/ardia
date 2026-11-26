import { isFields, isStringList } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { staticShortcutSources } from "../commands/commandCatalog";
import { ctrlTabUpgrade } from "../commands/ctrlTabKeys";
import type { ShortcutOverrides } from "../commands/shortcuts";
import type { Settings, SettingsMeta } from "./settings";

export const TAB_SWITCHER_MODES_APPLIED = "tabSwitcherOrder:fromShortcuts";

const isOverrides = (v: unknown): v is ShortcutOverrides => isFields(v) && Object.values(v).every(isStringList);

const STEPPED = { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" } as const;
const DEFAULT_MODES = { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" } as const;

type Upgraded<S> = { settings: S | undefined; settingsMeta: SettingsMeta };

function upgradedFields(fields: Record<string, unknown>, usedToStep: boolean): { fields: Record<string, unknown>; stepped: boolean } {
  if (!isOverrides(fields.shortcuts) || "tabSwitcherOrder" in fields || "tabSwitcherView" in fields) return { fields, stepped: false };
  const { shortcuts, stepped } = ctrlTabUpgrade(fields.shortcuts, staticShortcutSources(), { usedToStep });
  if (!stepped && shortcuts === fields.shortcuts) return { fields, stepped: false };
  return { fields: { ...fields, shortcuts, ...(stepped ? STEPPED : {}) }, stepped };
}

export function withTabSwitcherModes<S extends object>(saved: S | undefined, meta: SettingsMeta, usedToStep = PLATFORM_FEATURES.ctrlTabUsedToStep): Upgraded<S> {
  if (meta.inferred.includes(TAB_SWITCHER_MODES_APPLIED)) return { settings: saved, settingsMeta: meta };
  const settingsMeta = { chosen: meta.chosen, inferred: [...meta.inferred, TAB_SWITCHER_MODES_APPLIED] };
  if (!saved) return { settings: saved, settingsMeta };
  const { fields, stepped } = upgradedFields(saved as Record<string, unknown>, usedToStep);
  const marked = (keys: string[]) => [...new Set([...keys, ...Object.keys(STEPPED)])];
  return { settings: fields as S, settingsMeta: stepped ? { chosen: marked(settingsMeta.chosen), inferred: marked(settingsMeta.inferred) } : settingsMeta };
}

export function withSyncedTabSwitcherModes(patch: Partial<Settings>, modesExplicit: boolean): Partial<Settings> {
  if (!isOverrides(patch.shortcuts)) return patch;
  const { shortcuts, stepped } = ctrlTabUpgrade(patch.shortcuts, staticShortcutSources(), { usedToStep: false });
  if (modesExplicit || "tabSwitcherOrder" in patch || "tabSwitcherView" in patch) return shortcuts === patch.shortcuts ? patch : { ...patch, shortcuts };
  return { ...patch, shortcuts, ...(stepped ? STEPPED : DEFAULT_MODES) };
}
