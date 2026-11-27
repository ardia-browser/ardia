import type { SettingsMeta } from "./settings";

type RetiredDefault = { key: string; old: unknown; applied: string; waitsForSync: boolean };

export const TOOLBAR_SCROLL_DEFAULT_APPLIED = "hideToolbarWhileScrolling:offByDefault";
export const CMD_CLICK_GROUPS_DEFAULT_APPLIED = "cmdClickCreatesTabGroup:offByDefault";

export const RETIRED_DEFAULTS: readonly RetiredDefault[] = [
  { key: "hideToolbarWhileScrolling", old: true, applied: TOOLBAR_SCROLL_DEFAULT_APPLIED, waitsForSync: false },
  { key: "cmdClickCreatesTabGroup", old: true, applied: CMD_CLICK_GROUPS_DEFAULT_APPLIED, waitsForSync: true },
];

type Retired<S> = { settings: S | undefined; settingsMeta: SettingsMeta };
type RetireOptions = { waitForSync?: boolean; heldBySync?: (key: string) => boolean };

const marked = (meta: SettingsMeta, applied: string): SettingsMeta => ({ chosen: meta.chosen, inferred: [...meta.inferred, applied] });

export const chosenHere = (meta: SettingsMeta, key: string) => meta.chosen.includes(key) && !meta.inferred.includes(key);

function withRetiredDefault<S extends object>({ settings: saved, settingsMeta: meta }: Retired<S>, { key, old, applied, waitsForSync }: RetiredDefault, { waitForSync = false, heldBySync }: RetireOptions): Retired<S> {
  if (meta.inferred.includes(applied)) return { settings: saved, settingsMeta: meta };
  const without = (keys: string[]) => keys.filter((k) => k !== key);
  const unchosen = marked({ chosen: without(meta.chosen), inferred: without(meta.inferred) }, applied);
  if (heldBySync?.(key) && !chosenHere(meta, key)) return { settings: saved, settingsMeta: unchosen };
  const oldDefaultNobodyChose = !!saved && (saved as Record<string, unknown>)[key] === old && !chosenHere(meta, key);
  if (!oldDefaultNobodyChose) return { settings: saved, settingsMeta: marked(meta, applied) };
  if (waitForSync && waitsForSync) return { settings: saved, settingsMeta: meta };
  const { [key]: _untouched, ...settings } = saved as Record<string, unknown>;
  return { settings: settings as S, settingsMeta: unchosen };
}

export const withRetiredDefaults = <S extends object>(saved: S | undefined, meta: SettingsMeta, options: RetireOptions = {}): Retired<S> =>
  RETIRED_DEFAULTS.reduce<Retired<S>>((retired, retiredDefault) => withRetiredDefault(retired, retiredDefault, options), { settings: saved, settingsMeta: meta });

export const retiredDefaultsWaiting = (meta: SettingsMeta) => RETIRED_DEFAULTS.filter(({ applied }) => !meta.inferred.includes(applied)).map(({ key }) => key);

type SettingsState = { settings: unknown; settingsMeta: SettingsMeta };

const valueOf = (settings: unknown, key: string) => (settings && typeof settings === "object" ? (settings as Record<string, unknown>)[key] : undefined);

export const retiredDefaultsAppliedSince = (saved: SettingsState, now: SettingsState) =>
  RETIRED_DEFAULTS.some(({ key, old, applied }) =>
    !saved.settingsMeta.inferred.includes(applied) && now.settingsMeta.inferred.includes(applied) && valueOf(saved.settings, key) === old && valueOf(now.settings, key) !== old);
