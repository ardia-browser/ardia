import { create } from "zustand";
import { readDocument, writeDocument } from "../../platform/documents";
import type { LinkSource } from "../../lib/linkSource";
import { isIncognitoSpace } from "../browser/model";
import { useBrowser } from "../browser/store";
import {
  AIR_TRAFFIC_DOC,
  MAX_AIR_TRAFFIC_RULES,
  NO_AIR_TRAFFIC,
  airTrafficJson,
  parseAirTraffic,
  cleanRule,
  cleanTarget,
  sameTarget,
  type AirTrafficConfig,
  type AirTrafficRule,
  type AirTrafficTarget,
  type SourceApp,
} from "./rules";
import { hasRouteGroup } from "./groups";
import { LINK_SOURCES_DOC, parseRecentApps, recentAppsJson, withRecentApp } from "./sourceApps";

type Store = { loaded: boolean; config: AirTrafficConfig; recentApps: readonly SourceApp[] };

export const useAirTraffic = create<Store>()(() => ({ loaded: false, config: NO_AIR_TRAFFIC, recentApps: [] }));

function read(doc: string): string | null {
  try {
    return readDocument(doc);
  } catch {
    return null;
  }
}

function write(doc: string, json: string): boolean {
  try {
    if ((writeDocument(doc, json) as unknown) !== false) return true;
    console.warn(`[airTraffic] couldn't save ${doc}`);
    return false;
  } catch (error) {
    console.warn(`[airTraffic] couldn't save ${doc}`, error);
    return false;
  }
}

export function loadAirTraffic() {
  if (useAirTraffic.getState().loaded) return;
  useAirTraffic.setState({ loaded: true, config: parseAirTraffic(read(AIR_TRAFFIC_DOC)), recentApps: parseRecentApps(read(LINK_SOURCES_DOC)) });
}

export function currentAirTraffic(): AirTrafficConfig {
  loadAirTraffic();
  return useAirTraffic.getState().config;
}

export const targetUsableNow = (profileId: string, groupKey: string | null) => {
  const s = useBrowser.getState();
  return !!s.spaces[profileId] && !isIncognitoSpace(profileId) && (!groupKey || hasRouteGroup(s, profileId, groupKey));
};

function saveConfig(change: (config: AirTrafficConfig) => AirTrafficConfig): boolean {
  const before = currentAirTraffic();
  const config = change(before);
  if (config === before || !write(AIR_TRAFFIC_DOC, airTrafficJson(config))) return false;
  useAirTraffic.setState({ config });
  return true;
}

const newRuleId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export type RuleDraft = Omit<AirTrafficRule, "id">;

export type RuleAdded = { id: string } | { refused: "full" | "exists" | "unsaved" };

export function addAirTrafficRule(draft: RuleDraft, id = newRuleId()): string | null {
  const added = tryAddAirTrafficRule(draft, id);
  return "id" in added ? added.id : null;
}

export function tryAddAirTrafficRule(draft: RuleDraft, id = newRuleId()): RuleAdded {
  const rules = currentAirTraffic().rules;
  if (rules.length >= MAX_AIR_TRAFFIC_RULES) return { refused: "full" };
  if (rules.some((r) => r.id === id)) return { refused: "exists" };
  return saveConfig((c) => ({ ...c, rules: [...c.rules, cleanRule({ ...draft, id })] })) ? { id } : { refused: "unsaved" };
}

export function updateAirTrafficRule(id: string, patch: Partial<RuleDraft>): boolean {
  return saveConfig((c) => (c.rules.some((r) => r.id === id) ? { ...c, rules: c.rules.map((r) => (r.id === id ? cleanRule({ ...r, ...patch, id }) : r)) } : c));
}

export function removeAirTrafficRule(id: string) {
  saveConfig((c) => (c.rules.some((r) => r.id === id) ? { ...c, rules: c.rules.filter((r) => r.id !== id) } : c));
}

export function moveAirTrafficRule(id: string, step: -1 | 1) {
  saveConfig((c) => {
    const from = c.rules.findIndex((r) => r.id === id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= c.rules.length) return c;
    const rules = [...c.rules];
    [rules[from], rules[to]] = [rules[to]!, rules[from]!];
    return { ...c, rules };
  });
}

export function setAirTrafficFallback(given: AirTrafficTarget | null): boolean {
  const fallback = given && cleanTarget(given);
  return saveConfig((c) => (sameTarget(c.fallback, fallback) && c.fallbackChosen ? c : { ...c, fallback, fallbackChosen: true }));
}

export function noteLinkSource(source: LinkSource) {
  loadAirTraffic();
  const before = useAirTraffic.getState().recentApps;
  const recentApps = withRecentApp(before, source);
  if (recentApps === before) return;
  useAirTraffic.setState({ recentApps });
  write(LINK_SOURCES_DOC, recentAppsJson(recentApps));
}

export function resetAirTrafficForTests(config: AirTrafficConfig = NO_AIR_TRAFFIC, recentApps: readonly SourceApp[] = []) {
  useAirTraffic.setState({ loaded: true, config, recentApps });
}
