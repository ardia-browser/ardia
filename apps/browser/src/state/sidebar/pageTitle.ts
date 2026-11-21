import { useWindowId } from "../browser/hooks";
import { isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { addressBarInSidebar } from "../windows/layout";

export const pageNamesItsProfile = (s: BrowserState, windowId: string, profileId: string): boolean =>
  s.profileOrder.length >= 2 && !isIncognitoProfile(profileId) && !!s.profiles[profileId] && addressBarInSidebar(s, windowId);

export function usePageNamesItsProfile(profileId: string): boolean {
  const windowId = useWindowId();
  return useBrowser((s) => pageNamesItsProfile(s, windowId, profileId));
}
