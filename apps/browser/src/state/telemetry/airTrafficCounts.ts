import { currentAirTraffic } from "../airTraffic/store";
import { isWildcardPattern, type AirTrafficConfig } from "../airTraffic/rules";

type AirTrafficRouted = "rule" | "fallback" | "group";

const counts: Record<AirTrafficRouted, number> = { rule: 0, fallback: 0, group: 0 };
const ROUTED: readonly AirTrafficRouted[] = ["rule", "fallback", "group"];

export const noteAirTrafficLink = (by: AirTrafficRouted) => void counts[by]++;

export function takeAirTrafficCounts() {
  const taken = Object.fromEntries(ROUTED.map((by) => [`air_traffic_${by}_links`, counts[by]]));
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
  };
};

export const airTrafficSnapshot = () => airTrafficSetting(currentAirTraffic());
