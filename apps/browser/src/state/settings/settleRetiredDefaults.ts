import { useBrowser } from "../browser/store";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { RETIRED_DEFAULTS, withRetiredDefaults } from "./retiredDefaults";

export function settleRetiredDefaults(heldBySync: (key: string) => boolean) {
  const s = useBrowser.getState();
  const settled = withRetiredDefaults<Partial<Settings>>(s.settings, s.settingsMeta, { heldBySync });
  if (settled.settingsMeta === s.settingsMeta) return;
  const retired = RETIRED_DEFAULTS.filter(({ key }) => !(key in (settled.settings ?? {}))).map(({ key }) => [key, DEFAULT_SETTINGS[key as keyof Settings]]);
  if (retired.length) s.updateSettings(Object.fromEntries(retired), { fromSync: true });
  useBrowser.setState({ settingsMeta: settled.settingsMeta });
}
