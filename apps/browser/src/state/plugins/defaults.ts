import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { readConfigFile } from "../../platform/configFolder";
import { useBrowser } from "../browser/store";
import { checkedSettings, CONFIG_FILE, sameValue } from "../config/configSettings";
import type { Settings } from "../settings/settings";
import type { PluginRecord } from "./store";

function keysConfigSets(): ReadonlySet<string> {
  try {
    const read = readConfigFile(CONFIG_FILE);
    if (read.status !== "ok") return new Set();
    const doc: unknown = JSON.parse(read.text);
    return isFields(doc) && isFields(doc.settings) ? new Set(Object.keys(doc.settings)) : new Set();
  } catch {
    return new Set();
  }
}

type Step = PluginRecord["applied"][string];
type Claims = ReadonlyMap<string, Step & { owner: string }>;

function claimsOf(records: Record<string, PluginRecord>, except: string): Claims {
  const claims = new Map<string, Step & { owner: string }>();
  for (const [name, record] of Object.entries(records)) {
    if (name === except || !record.enabled) continue;
    for (const [key, step] of Object.entries(record.applied)) if (step.order >= (claims.get(key)?.order ?? -1)) claims.set(key, { ...step, owner: name });
  }
  return claims;
}

function nextOrder(records: Record<string, PluginRecord>): number {
  let highest = 0;
  for (const record of Object.values(records)) for (const step of Object.values(record.applied)) highest = Math.max(highest, step.order);
  return highest + 1;
}

function planDefaults(m: PluginManifest, settings: Settings, fileKeys: ReadonlySet<string>, claims: Claims = new Map(), order = 1): { patch: Partial<Settings>; applied: PluginRecord["applied"] } {
  const { values } = checkedSettings("plugin.json", m.settings.defaults, settings);
  const patch: Record<string, unknown> = {};
  const applied: PluginRecord["applied"] = {};
  for (const [key, value] of Object.entries(values)) {
    if (fileKeys.has(key)) continue;
    const previous = settings[key as keyof Settings];
    const same = sameValue(previous, value);
    const claim = claims.get(key);
    if (same && !claim) continue;
    if (!same) patch[key] = value;
    applied[key] = { value, previous, order, over: claim && sameValue(previous, claim.value) ? claim.owner : null };
  }
  return { patch: patch as Partial<Settings>, applied };
}

function planRestore(applied: PluginRecord["applied"], settings: Settings, claims: Claims = new Map(), fileKeys: ReadonlySet<string> = new Set()): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const [key, { value, previous, order }] of Object.entries(applied)) {
    if (!(key in settings) || fileKeys.has(key)) continue;
    if ((claims.get(key)?.order ?? -1) > order) continue;
    if (sameValue(settings[key as keyof Settings], value)) patch[key] = previous;
  }
  return patch as Partial<Settings>;
}

export function spliceApplied(records: Record<string, PluginRecord>, leaving: string): Record<string, PluginRecord> {
  const gone = records[leaving]?.applied ?? {};
  const out = { ...records };
  for (const [key, step] of Object.entries(gone)) {
    for (const [name, record] of Object.entries(out)) {
      const mine = record.applied[key];
      if (name === leaving || !record.enabled || mine?.over !== leaving) continue;
      out[name] = { ...record, applied: { ...record.applied, [key]: { ...mine, previous: step.previous, over: step.over } } };
    }
  }
  return out;
}

export function planEnable(m: PluginManifest, records: Record<string, PluginRecord>, name: string, before: PluginRecord["applied"]): { patch: Partial<Settings>; applied: PluginRecord["applied"] } {
  const settings = useBrowser.getState().settings;
  const fileKeys = keysConfigSets();
  const restore = planRestore(before, settings, claimsOf(records, name), fileKeys);
  const plan = planDefaults(m, { ...settings, ...restore }, fileKeys, claimsOf(records, name), nextOrder(records));
  return { patch: { ...restore, ...plan.patch }, applied: plan.applied };
}

export const planDisable = (records: Record<string, PluginRecord>, name: string): Partial<Settings> =>
  planRestore(records[name]?.applied ?? {}, useBrowser.getState().settings, claimsOf(records, name), keysConfigSets());

export function applySettingsPatch(patch: Partial<Settings>) {
  if (Object.keys(patch).length) useBrowser.getState().updateSettings(patch);
}
