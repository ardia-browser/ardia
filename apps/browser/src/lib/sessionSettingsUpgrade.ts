import { isFields, isStringList } from "./decode";
import type { SavedObject } from "./savedDocument";

type SavedSettings = SavedObject & { chosen?: string[]; inferred?: string[] };

export function sessionWithSettingsMeta(doc: SavedObject): SavedObject {
  if (!isFields(doc.settings) || (isFields(doc.settingsMeta) && !("chosen" in doc.settings) && !("inferred" in doc.settings))) return doc;
  const raw = withNewTabButtonPosition(withoutBatterySaver(doc.settings as SavedSettings))!;
  const legacy = !("chosen" in raw) ? Object.keys(raw) : null;
  const { chosen, inferred, ...settings } = raw;
  return { ...doc, settings, settingsMeta: { chosen: legacy ?? (isStringList(chosen) ? chosen : []), inferred: legacy ?? (isStringList(inferred) ? inferred : []) } };
}

function withoutUntouchedSetting(doc: SavedObject, key: string, oldDefault: unknown): SavedObject {
  if (!isFields(doc.settings) || doc.settings[key] !== oldDefault) return doc;
  const meta = isFields(doc.settingsMeta) ? doc.settingsMeta : {};
  const chosen = isStringList(meta.chosen) ? meta.chosen : [];
  const inferred = isStringList(meta.inferred) ? meta.inferred : [];
  if (chosen.includes(key) && !inferred.includes(key)) return doc;
  const { [key]: _untouched, ...settings } = doc.settings;
  const without = (keys: string[]) => keys.filter((name) => name !== key);
  return { ...doc, settings, settingsMeta: { chosen: without(chosen), inferred: without(inferred) } };
}

export const sessionWithNewTabLinksInLittleArdia = (doc: SavedObject) => withoutUntouchedSetting(doc, "littleArdiaOpensNewTabLinks", false);

export const sessionWithUnreadCountsOffByDefault = (doc: SavedObject) => withoutUntouchedSetting(doc, "showUnreadCounts", true);

function withNewTabButtonPosition(saved: SavedSettings | undefined): SavedSettings | undefined {
  if (!saved || saved.newTabButtonPosition !== undefined || saved.newTabPosition !== "top") return saved;
  const alongside = (keys: string[]) => (keys.includes("newTabPosition") ? [...new Set([...keys, "newTabButtonPosition"])] : keys);
  return {
    ...saved,
    newTabButtonPosition: "top",
    ...(isStringList(saved.chosen) ? { chosen: alongside(saved.chosen) } : {}),
    ...(isStringList(saved.inferred) ? { inferred: alongside(saved.inferred) } : {}),
  };
}

function withoutBatterySaver(saved: (SavedSettings) | undefined): SavedSettings | undefined {
  if (!saved || !("batterySaver" in saved)) return saved;
  const { batterySaver, ...rest } = saved;
  const explicit = batterySaver === false || (batterySaver === true && isStringList(rest.chosen) && rest.chosen.includes("batterySaver") && !(isStringList(rest.inferred) && rest.inferred.includes("batterySaver")));
  const without = (keys: string[]) => keys.filter((k) => k !== "batterySaver");
  return {
    ...rest,
    ...(isStringList(rest.chosen) ? { chosen: explicit ? [...new Set([...without(rest.chosen), "batterySaverWhen"])] : without(rest.chosen) } : {}),
    ...(isStringList(rest.inferred) ? { inferred: without(rest.inferred) } : {}),
    ...(explicit && rest.batterySaverWhen === undefined ? { batterySaverWhen: batterySaver ? "unplugged" : "never" } : {}),
  };
}
