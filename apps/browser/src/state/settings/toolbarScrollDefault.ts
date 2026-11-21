import type { SettingsMeta } from "./settings";

const KEY = "hideToolbarWhileScrolling";
const OLD_DEFAULT = true;
export const TOOLBAR_SCROLL_DEFAULT_APPLIED = "hideToolbarWhileScrolling:offByDefault";

export function withToolbarKeptWhileScrolling<S extends object>(saved: S | undefined, meta: SettingsMeta): { settings: S | undefined; settingsMeta: SettingsMeta } {
  if (meta.inferred.includes(TOOLBAR_SCROLL_DEFAULT_APPLIED)) return { settings: saved, settingsMeta: meta };
  const marked = (m: SettingsMeta): SettingsMeta => ({ chosen: m.chosen, inferred: [...m.inferred, TOOLBAR_SCROLL_DEFAULT_APPLIED] });
  const untouchedOn = !!saved && (saved as Record<string, unknown>)[KEY] === OLD_DEFAULT && !(meta.chosen.includes(KEY) && !meta.inferred.includes(KEY));
  if (!untouchedOn) return { settings: saved, settingsMeta: marked(meta) };
  const { [KEY]: _untouched, ...settings } = saved as Record<string, unknown>;
  const without = (keys: string[]) => keys.filter((k) => k !== KEY);
  return { settings: settings as S, settingsMeta: marked({ chosen: without(meta.chosen), inferred: without(meta.inferred) }) };
}
