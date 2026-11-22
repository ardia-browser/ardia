import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { setInAppLinkRoutes } from "../../platform/pageOptions";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { lastActiveProfile } from "../windows/small";
import { inAppLinkRoutes } from "./pageLinkRoutes";
import { currentAirTraffic, targetUsableNow, useAirTraffic } from "./store";

const sent = new Map<string, string>();

export function inAppLinkRoutesByEngineProfile(): Map<string, string> {
  const config = currentAirTraffic();
  const state = useBrowser.getState();
  const sources = new Map<string, Set<string>>();
  if (config.inAppLinks)
    for (const id of Object.keys(state.profiles)) {
      if (isIncognitoProfile(id)) continue;
      const key = engineProfile(state, id);
      sources.set(key, (sources.get(key) ?? new Set()).add(id));
    }
  const last = lastActiveProfile(state);
  const out = new Map<string, string>();
  for (const [key, profiles] of sources) out.set(key, JSON.stringify(inAppLinkRoutes(config, profiles, targetUsableNow, last)));
  return out;
}

export function startInAppLinkSync() {
  if (!PLATFORM_FEATURES.routesLinkClicks) return;
  const sync = () => {
    const next = inAppLinkRoutesByEngineProfile();
    for (const key of sent.keys()) if (!next.has(key)) next.set(key, "[]");
    for (const [key, routes] of next) {
      if (sent.get(key) === routes) continue;
      if (routes === "[]") sent.delete(key);
      else sent.set(key, routes);
      void setInAppLinkRoutes(key, JSON.parse(routes)).catch(() => sent.delete(key));
    }
  };
  sync();
  useBrowser.subscribeTo(["profiles", "windows", "windowOrder", "ui", "settings", "groups", "parkedPins"], sync);
  useAirTraffic.subscribe(sync);
}
