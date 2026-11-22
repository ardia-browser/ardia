import { sameValue, checkedSettings } from "../config/configSettings";
import { isConfigSettingKey } from "../settings/configAllowlist";
import { controllingSearchExtension, DEFAULT_SETTINGS, defaultSearchEngine, SETTING_KEYS, SETTING_SPECS, searchEngines, type SettingKey, type Settings } from "../settings/settings";
import { chooseTabLayout } from "../settings/actions";
import { tabLayoutOf } from "../browser/model";
import type { MethodSpec } from "./socketCatalog";
import { checkedByRules, hasSocketRule, searchProblem } from "./socketSettingRules";
import { id, ids, obj, text } from "./socketSchema";
import { expect, now } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


const OWN_METHOD: Partial<Record<SettingKey, string>> = {
  defaultProfileId: "profiles.setDefault",
  customSearchEngines: t(`search.add, search.update and search.remove`),
  cliControl: t(`nothing: the ardia command can't switch its own control`),
  allowJavaScriptFromAppleEvents: t(`nothing: it would let any AppleScript run script in every page`),
  extensionSearchEngines: t(`nothing: it mirrors the search engines extensions add, so install, turn off or remove the extension (extensions.*)`),
};

const whyNot = (key: string) => {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) return `${key} isn't a setting`;
  if (isConfigSettingKey(key) || hasSocketRule(key)) return null;
  const own = OWN_METHOD[key as SettingKey];
  return own ? `${key} is set with ${own}` : `${key} can't be set from the ardia command yet`;
};

function getSettings(params: Record<string, unknown>) {
  const s = now().settings;
  const keys = (params.keys as string[] | undefined) ?? SETTING_KEYS;
  const unknown = keys.filter((k) => !(SETTING_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new OpError("bad_request", `Not settings: ${unknown.join(", ")}.`);
  return Object.fromEntries(keys.map((k) => [k, s[k as SettingKey]]));
}

const SHORTCUTS_INPUT = { type: "object", additionalProperties: { type: "string" }, description: t(`Command id to a shortcut like "cmd+shift+t" or "⇧⌘T", or "" for none; settings.set adds these to the custom shortcuts`) };

const settingsSchema = () =>
  SETTING_KEYS.map((key) => ({
    key,
    schema: key === "shortcuts" ? SHORTCUTS_INPUT : SETTING_SPECS[key].schema,
    default: SETTING_SPECS[key].default,
    writable: whyNot(key) === null,
    ...(whyNot(key) ? { why: whyNot(key) } : {}),
    synced: SETTING_SPECS[key].synced,
  }));

function refuseWhileExtensionControlsSearch() {
  const controlling = controllingSearchExtension(now().settings);
  if (controlling) throw new OpError("refused", `${controlling.extensionName || "An extension"} controls the default search engine; turn it off or change its settings first.`);
}

const windowLayouts = () => Object.keys(now().windows).map((id) => `${id}:${tabLayoutOf(now(), id)}`).join(",");

function apply(values: Record<string, unknown>, label: string, replaced: Partial<Settings> = {}) {
  const refused = Object.keys(values).map(whyNot).filter((w): w is string => !!w);
  if (refused.length) throw new OpError("refused", `${refused.join("; ")}.`);
  if (Object.hasOwn(values, "searchEngine")) refuseWhileExtensionControlsSearch();
  const settings = now().settings;
  const ruled = Object.fromEntries(Object.entries(values).filter(([key]) => hasSocketRule(key)));
  const fromRules = checkedByRules(ruled, settings, values);
  const { values: checked, problems } = checkedSettings(label, Object.fromEntries(Object.entries(values).filter(([key]) => !hasSocketRule(key))), { ...settings, ...fromRules.patch });
  problems.push(...fromRules.problems.map((p) => `${label}: ${p}`));
  const merged = { ...fromRules.patch, ...checked, ...replaced };
  const problem = problems.length ? null : searchProblem(settings, { ...settings, ...merged } as Settings);
  if (problem) problems.push(`${label}: ${problem}`);
  if (problems.length) throw new OpError("bad_request", problems.join("; "));
  const patch: Partial<Record<SettingKey, unknown>> = {};
  for (const [key, value] of Object.entries(merged) as [SettingKey, unknown][]) if (!sameValue(value, settings[key])) patch[key] = value;
  const layouts = windowLayouts();
  if (Object.keys(patch).length) now().updateSettings(patch as Partial<Settings>);
  const layout = (Object.hasOwn(checked, "tabLayout") ? checked.tabLayout : patch.tabLayout) as Settings["tabLayout"] | undefined;
  if (layout !== undefined) chooseTabLayout(layout);
  const after = now().settings;
  const moved = layout !== undefined && windowLayouts() !== layouts;
  const changed = Object.keys(patch).filter((k) => !sameValue(after[k as SettingKey], settings[k as SettingKey]));
  if (moved && !changed.includes("tabLayout")) changed.push("tabLayout");
  return { changed, values: Object.fromEntries(Object.keys(values).map((k) => [k, after[k as SettingKey]])) };
}

function reset(params: Record<string, unknown>) {
  const keys = params.keys as string[];
  const values = Object.fromEntries(keys.map((k) => [k, Object.hasOwn(DEFAULT_SETTINGS, k) ? (DEFAULT_SETTINGS as Record<string, unknown>)[k] : undefined]));
  return apply(values, "settings.reset", keys.includes("shortcuts") ? { shortcuts: { ...DEFAULT_SETTINGS.shortcuts } } : {});
}

const engineRows = () => {
  const s = now().settings;
  const effective = defaultSearchEngine(s).id;
  const controlling = controllingSearchExtension(s);
  return searchEngines(s).map((e) => ({
    id: e.id,
    name: e.name,
    keyword: e.keyword,
    url: e.url,
    custom: !!e.custom,
    default: e.id === effective,
    ...(e.id === effective && controlling ? { controlledBy: controlling.extensionId } : {}),
  }));
};

function engineOf(value: unknown) {
  const engine = engineRows().find((e) => e.id === value);
  if (!engine) throw new OpError("no_window", `There's no search engine ${String(value)}.`);
  return engine;
}

const engineInput = (params: Record<string, unknown>, was?: { name: string; keyword: string; url: string }) => ({
  name: (params.name as string | undefined) ?? was?.name ?? "",
  keyword: (params.keyword as string | undefined) ?? was?.keyword ?? "",
  url: (params.url as string | undefined) ?? was?.url ?? "",
});

function addEngine(params: Record<string, unknown>) {
  const made = now().addCustomEngine(engineInput(params));
  if ("error" in made) throw new OpError("bad_request", made.error);
  return engineOf(made.id);
}

function refuseLegacyEngine(engine: { id: string }) {
  if (engine.id === "custom" && !now().settings.customSearchEngines.some((e) => e.id === "custom")) {
    throw new OpError("refused", t(`The Custom engine comes from the custom search URL setting, which the socket doesn't change; edit it in Settings › Search.`));
  }
}

function updateEngine(params: Record<string, unknown>) {
  const was = engineOf(params.id);
  if (!was.custom) throw new OpError("refused", `${was.name} is built in; only engines added in Settings change.`);
  refuseLegacyEngine(was);
  const problem = now().updateCustomEngine(was.id, engineInput(params, was));
  if (problem) throw new OpError("bad_request", problem);
  return engineOf(was.id);
}

function removeEngine(params: Record<string, unknown>) {
  const was = engineOf(params.id);
  if (!was.custom) throw new OpError("refused", `${was.name} is built in; only engines added in Settings can be removed.`);
  refuseLegacyEngine(was);
  now().removeCustomEngine(was.id);
  expect(!engineRows().some((e) => e.id === was.id), t(`the engine is still there.`));
  return { ok: true };
}

const ENGINE_FIELDS = { name: text(t(`Its name`)), keyword: text(t(`The keyword that searches it from the address bar`)), url: text(t(`Its search URL, with %s for the query`)) };

export const SETTINGS_METHODS: MethodSpec[] = [
  { name: "settings.get", mutates: false, description: t(`Settings and their values: every one, or the keys given`), params: obj({ keys: ids(t(`Setting keys`), 200) }), result: t(`{key: value}`), run: getSettings },
  { name: "settings.schema", mutates: false, description: t(`Every setting: its JSON schema, default, whether the command can set it, and whether it syncs`), params: obj({}), result: t(`[{key, schema, default, writable, why?, synced}]`), run: settingsSchema },
  {
    name: "settings.set",
    mutates: true,
    description: t(`Change settings, as the Settings window does; the keys and values config.json takes. Nothing changes unless every value is valid`),
    params: obj({ values: { type: "object", description: t(`Setting key to new value (settings.schema lists them)`) } }, ["values"]),
    result: t(`{changed, values}`),
    run: (p) => apply(p.values as Record<string, unknown>, "settings.set"),
  },
  { name: "settings.reset", mutates: true, description: t(`Put settings back to their defaults`), params: obj({ keys: ids(t(`Setting keys`), 200) }, ["keys"]), result: t(`{changed, values}`), run: reset },
  { name: "search.engines", mutates: false, description: t(`Search engines: built in, added in Settings and from extensions; default marks the one searches use, and controlledBy names the extension that set it`), params: obj({}), result: t(`[{id, name, keyword, url, custom, default, controlledBy?}]`), run: engineRows },
  {
    name: "search.setDefault",
    mutates: true,
    description: t(`Make a search engine the default; refused while an extension controls it, as Settings disables the picker`),
    params: obj({ id: id(t(`An engine id from search.engines`)) }, ["id"]),
    result: "engine",
    run: (p) => {
      const engine = engineOf(p.id);
      refuseWhileExtensionControlsSearch();
      now().setSearchEngine(engine.id);
      expect(defaultSearchEngine(now().settings).id === engine.id, `${engine.name} isn't the default.`);
      return engineOf(engine.id);
    },
  },
  { name: "search.add", mutates: true, description: t(`Add a search engine`), params: obj(ENGINE_FIELDS, ["name", "keyword", "url"]), result: "engine", run: addEngine },
  { name: "search.update", mutates: true, description: t(`Change a search engine added in Settings`), params: obj({ id: id(t(`An engine id`)), ...ENGINE_FIELDS }, ["id"]), result: "engine", run: updateEngine },
  { name: "search.remove", mutates: true, description: t(`Remove a search engine added in Settings`), params: obj({ id: id(t(`An engine id`)) }, ["id"]), result: "{ok}", run: removeEngine },
];
