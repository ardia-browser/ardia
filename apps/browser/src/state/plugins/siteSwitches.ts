import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { switchOrigin } from "../../lib/pluginPageBar";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { isPeekTab } from "../peek/peek";
import { takeTypedAddress } from "./typedAddresses";
import { consentNow } from "../telemetry/choice";
import { noteSiteSwitch, noteSiteSwitchTypedOn } from "../telemetry/pageBarCounts";
import { updateRecord } from "./lifecycle";
import { activeManifest, activeNames, currentPlugins, NO_RECORD, recordOf, usePlugins, type PluginsStore } from "./store";
import { valuesOf } from "./values";

type Plugins = Pick<PluginsStore, "listings" | "records" | "order">;

export function siteSwitchValue(s: Pick<PluginsStore, "records">, plugin: string, key: string, origin: string): boolean | undefined {
  const sites = recordOf(s, plugin).sites;
  if (!sites || !Object.hasOwn(sites, key)) return undefined;
  const values = sites[key]!;
  return Object.hasOwn(values, origin) ? values[origin] : undefined;
}

export const pluginOrder = (s: Plugins): string[] => [...activeNames(s)].sort();

export type SiteSwitchRow = { plugin: string; key: string; title: string; icon: string; on: boolean };

export function siteSwitchRows(s: Plugins, url: string): SiteSwitchRow[] {
  const origin = switchOrigin(url);
  if (!origin) return [];
  return pluginOrder(s).flatMap((plugin) =>
    activeManifest(s, plugin)!.siteSwitches.map((sw) => ({ plugin, key: sw.key, title: sw.title, icon: sw.icon, on: siteSwitchValue(s, plugin, sw.key, origin) === true })),
  );
}

export function setSiteSwitch(plugin: string, key: string, url: string, on: boolean, by: "you" | "typed" = "you"): boolean {
  const s = currentPlugins();
  const origin = switchOrigin(url);
  if (!origin || !activeManifest(s, plugin)?.siteSwitches.some((sw) => sw.key === key)) return false;
  if (siteSwitchValue(s, plugin, key, origin) === on) return true;
  const saved = updateRecord(
    plugin,
    (r) => {
      const base = r === NO_RECORD ? { ...NO_RECORD } : r;
      const sites = base.sites ?? {};
      const values = Object.hasOwn(sites, key) ? sites[key]! : {};
      return { ...base, sites: { ...sites, [key]: { ...values, [origin]: on } } };
    },
    consentNow(),
  );
  if (saved && by === "you") noteSiteSwitch(on);
  if (saved && by === "typed") noteSiteSwitchTypedOn();
  return saved;
}

export function consumeTypedAddress(tabId: string, committedUrl: string, committedAt: number, privatePage: boolean) {
  const origin = takeTypedAddress(tabId, committedUrl, committedAt);
  if (!origin || privatePage) return;
  const s = currentPlugins();
  for (const plugin of pluginOrder(s)) {
    const bar = activeManifest(s, plugin)!.pageBar;
    if (!bar?.when.siteSwitch || !bar.when.localAddresses || valuesOf(s, plugin)[bar.when.localAddresses] !== true) continue;
    if (siteSwitchValue(s, plugin, bar.when.siteSwitch, origin) !== undefined) continue;
    setSiteSwitch(plugin, bar.when.siteSwitch, committedUrl, true, "typed");
  }
}

export function useSiteSwitchRows(tabId: string): SiteSwitchRow[] {
  const url = useBrowser((s) => {
    const t = s.tabs[tabId];
    return t && !isIncognitoProfile(t.profileId) && !isPeekTab(s, tabId) ? t.url : "";
  });
  const plugins = usePlugins(useShallow((s) => ({ listings: s.listings, records: s.records, order: s.order })));
  return useMemo(() => (url ? siteSwitchRows(plugins, url) : []), [url, plugins]);
}
