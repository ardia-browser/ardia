import { isFields, isStringList } from "../../lib/decode";
import type { SavedObject } from "../../lib/savedDocument";
import { parseSettingsMeta, type Settings, type SettingsMeta } from "./settings";

export function sessionWithSettingsMeta(doc: SavedObject): SavedObject {
  if (!isFields(doc.settings) || (isFields(doc.settingsMeta) && !("chosen" in doc.settings) && !("inferred" in doc.settings))) return doc;
  const raw = withNewTabButtonPosition(withoutBatterySaver(doc.settings as Partial<Settings & SettingsMeta> & { batterySaver?: unknown }))!;
  const legacy = !raw.chosen ? Object.keys(raw) : null;
  const { chosen, inferred, ...settings } = raw;
  return { ...doc, settings, settingsMeta: { chosen: legacy ?? (isStringList(chosen) ? chosen : []), inferred: legacy ?? (isStringList(inferred) ? inferred : []) } };
}

function withNewTabButtonPosition(saved: Partial<Settings & SettingsMeta> | undefined): Partial<Settings & SettingsMeta> | undefined {
  if (!saved || saved.newTabButtonPosition !== undefined || saved.newTabPosition !== "top") return saved;
  const alongside = (keys: string[]) => (keys.includes("newTabPosition") ? [...new Set([...keys, "newTabButtonPosition"])] : keys);
  return {
    ...saved,
    newTabButtonPosition: "top",
    ...(saved.chosen ? { chosen: alongside(saved.chosen) } : {}),
    ...(saved.inferred ? { inferred: alongside(saved.inferred) } : {}),
  };
}

function withoutBatterySaver(saved: (Partial<Settings & SettingsMeta> & { batterySaver?: unknown }) | undefined): Partial<Settings & SettingsMeta> | undefined {
  if (!saved || !("batterySaver" in saved)) return saved;
  const { batterySaver, ...rest } = saved;
  const explicit = batterySaver === false || (batterySaver === true && !!rest.chosen?.includes("batterySaver") && !rest.inferred?.includes("batterySaver"));
  const without = (keys: string[]) => keys.filter((k) => k !== "batterySaver");
  return {
    ...rest,
    ...(rest.chosen ? { chosen: explicit ? [...new Set([...without(rest.chosen), "batterySaverWhen"])] : without(rest.chosen) } : {}),
    ...(rest.inferred ? { inferred: without(rest.inferred) } : {}),
    ...(explicit && rest.batterySaverWhen === undefined ? { batterySaverWhen: batterySaver ? "unplugged" : "never" } : {}),
  };
}

function withoutUntouchedSetting(doc: SavedObject, key: string, oldDefault: unknown): SavedObject {
  if (!isFields(doc.settings) || doc.settings[key] !== oldDefault) return doc;
  const { chosen, inferred } = parseSettingsMeta(doc.settingsMeta);
  if (chosen.includes(key) && !inferred.includes(key)) return doc;
  const { [key]: _untouched, ...settings } = doc.settings;
  const without = (keys: string[]) => keys.filter((k) => k !== key);
  return { ...doc, settings, settingsMeta: { chosen: without(chosen), inferred: without(inferred) } };
}

export const sessionWithNewTabLinksInLittleArdia = (doc: SavedObject) => withoutUntouchedSetting(doc, "littleArdiaOpensNewTabLinks", false);

export const sessionWithUnreadCountsOffByDefault = (doc: SavedObject) => withoutUntouchedSetting(doc, "showUnreadCounts", true);
