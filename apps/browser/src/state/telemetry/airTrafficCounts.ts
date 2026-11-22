import { currentAirTraffic } from "../airTraffic/store";
import { isWildcardPattern, type AirTrafficConfig } from "../airTraffic/rules";

export type AirTrafficRouted = "rule" | "fallback" | "group";

const counts: Record<AirTrafficRouted, number> = { rule: 0, fallback: 0, group: 0 };
const ROUTED: readonly AirTrafficRouted[] = ["rule", "fallback", "group"];
export type InAppLinkVia = "newTab" | "click" | "typed";
type InAppCount = InAppLinkVia | "clickMiss";

const inApp: Record<InAppCount, number> = { newTab: 0, click: 0, typed: 0, clickMiss: 0 };
const IN_APP_FIELDS: Record<InAppCount, string> = {
  newTab: "air_traffic_in_app_links",
  click: "air_traffic_in_app_clicks",
  typed: "air_traffic_in_app_typed",
  clickMiss: "air_traffic_in_app_click_misses",
};

export const noteAirTrafficLink = (by: AirTrafficRouted) => void counts[by]++;
export const noteAirTrafficInApp = (via: InAppCount) => void inApp[via]++;

export function takeAirTrafficCounts() {
  const taken: Record<string, number> = Object.fromEntries(ROUTED.map((by) => [`air_traffic_${by}_links`, counts[by]]));
  for (const via of Object.keys(inApp) as InAppCount[]) {
    taken[IN_APP_FIELDS[via]] = inApp[via];
    inApp[via] = 0;
  }
  for (const by of ROUTED) counts[by] = 0;
  return taken;
}

export const airTrafficSetting = (config: AirTrafficConfig): Record<string, string> => {
  const enabled = config.rules.filter((r) => r.enabled);
  return {
    air_traffic_rules: String(enabled.length),
    air_traffic_wildcard_rules: String(enabled.filter((r) => r.when.kind === "pattern" && isWildcardPattern(r.when.pattern)).length),
    air_traffic_fallback: config.fallback ? "true" : "false",
    air_traffic_group_rules: String(enabled.filter((r) => r.groupKey).length),
    air_traffic_in_app: config.inAppLinks ? "true" : "false",
  };
};

export const airTrafficSnapshot = () => airTrafficSetting(currentAirTraffic());
