import { setInAppLinkPatterns } from "../../platform/pageOptions";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { inAppLinkPatterns } from "./rules";
import { currentAirTraffic, targetUsableNow, useAirTraffic } from "./store";
import { lastActiveProfile } from "../windows/small";

const sent = new Map<string, string>();

export function startInAppLinkSync() {
  const sync = () => {
    const config = currentAirTraffic();
    const state = useBrowser.getState();
    const last = lastActiveProfile(state);
    const next = new Map<string, string>();
    if (config.inAppLinks)
      for (const id of Object.keys(state.profiles)) {
        if (isIncognitoProfile(id)) continue;
        next.set(engineProfile(state, id), JSON.stringify(inAppLinkPatterns(config, id, targetUsableNow, last)));
      }
    for (const key of [...sent.keys()]) if (!next.has(key)) sent.delete(key);
    for (const [key, patterns] of next) {
      if (sent.get(key) === patterns) continue;
      sent.set(key, patterns);
      void setInAppLinkPatterns(key, JSON.parse(patterns) as [string, string][]);
    }
  };
  sync();
  useBrowser.subscribeTo(["profiles", "windows", "windowOrder", "ui", "settings", "groups", "parkedPins"], sync);
  useAirTraffic.subscribe(sync);
}
