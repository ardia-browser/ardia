import type { InstalledExtension } from "../../platform/extensions";
import { isIncognitoProfile } from "../browser/model";
import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { tabEngine } from "../engines/engines";
import { isInternalTab } from "../pages/urls";
import { splitOf } from "../splits/splits";
import { isMaterialized } from "./materialized";
import { restoredLazily } from "./pageSession";

const hasTabPermission = (permission: string): boolean =>
  permission === "tabs" ||
  permission === "tabGroups" ||
  /browsing history|tab groups/i.test(permission);

export const hasTabAccess = (extensions: readonly InstalledExtension[]): boolean =>
  extensions.some((x) => x.enabled && x.permissions.some(hasTabPermission));

export function materializeCandidates(s: BrowserState, windowId: string): Tab[] {
  const w = s.windows[windowId];
  if (!w || w.kind !== "main" || isIncognitoProfile(w.profileId)) return [];
  const grouped = new Set(Object.values(s.groups).flatMap((g) => g.tabIds));
  return w.tabIds.flatMap((id) => {
    const t = s.tabs[id];
    if (!t || t.profileId !== w.profileId) return [];
    if (!restoredLazily(t) || !t.url || isInternalTab(t)) return [];
    if (t.pin || t.pinKey || isMaterialized(t.id) || grouped.has(t.id)) return [];
    if (splitOf(s, t.id) || tabEngine(s, t.id) !== "chromium") return [];
    return [t];
  });
}
