import { currentAirTraffic } from "../airTraffic/store";
import { isWildcardPattern, type AirTrafficConfig } from "../airTraffic/rules";

export type AirTrafficRouted = "rule" | "fallback" | "group";

const counts: Record<AirTrafficRouted, number> = { rule: 0, fallback: 0, group: 0 };
const ROUTED: readonly AirTrafficRouted[] = ["rule", "fallback", "group"];
let byInApp = 0;
let byInAppClick = 0;
let byInAppTyped = 0;

export const noteAirTrafficLink = (by: AirTrafficRouted) => void counts[by]++;
export const noteAirTrafficInAppLink = () => void byInApp++;
export const noteAirTrafficInAppClick = () => void byInAppClick++;
export const noteAirTrafficInAppTyped = () => void byInAppTyped++;

export function takeAirTrafficCounts() {
  const taken = {
    ...Object.fromEntries(ROUTED.map((by) => [`air_traffic_${by}_links`, counts[by]])),
    air_traffic_in_app_links: byInApp,
    air_traffic_in_app_clicks: byInAppClick,
    air_traffic_in_app_typed: byInAppTyped,
  };
  for (const by of ROUTED) counts[by] = 0;
  byInApp = 0;
  byInAppClick = 0;
  byInAppTyped = 0;
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
