import { pagerFor, type PagerPage } from "./profilePager";
import { useShallow } from "zustand/react/shallow";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, showsEmptyWindow, tabsShownIn } from "../browser/model";
import { focusedWindowOf } from "./ui";
import { sidebarAddressChosen } from "./layout";

export const useWindowUiOf = <T>(windowId: string, select: (ui: BrowserState["windowUi"][string] | undefined) => T): T =>
  useBrowser((s) => select(s.windowUi[windowId]));


export function nativeWindowProfile(s: BrowserState, windowId: string, warm: readonly PagerPage[] | null): [profile: string, neighbours: string, selection: string] {
  const w = s.windows[windowId];
  if (!w) return ["", "[]", ""];
  const at = w.kind === "private" ? -1 : s.profileOrder.indexOf(w.profileId);
  const around = warm ? warm.map((p) => p.id) : [s.profileOrder[at - 1], s.profileOrder[at + 1]];
  const ids = at < 0 ? [] : around.filter((id): id is string => !!id && id !== w.profileId && !!s.profiles[id]);
  return [engineProfile(s, w.profileId), JSON.stringify(ids.map((id) => engineProfile(s, id))), w.profileId];
}

export function useNativeWindowProfile(windowId: string) {
  const warm = pagerFor(windowId).state((st) => st.pages);
  return useBrowser(useShallow((s) => nativeWindowProfile(s, windowId, warm)));
}

export const useSidebarDockState = (windowId: string) =>
  useBrowser(
    useShallow(
      (s) =>
        [
          tabsShownIn(s, windowId),
          sidebarAddressChosen(s.settings),
        ] as const,
    ),
  );

export const useShowsEmptyWindow = (windowId: string) => useBrowser((s) => showsEmptyWindow(s, windowId));

export const useProfileNeighbours = (windowId: string) =>
  useBrowser(
    useShallow((s): [previous: boolean, next: boolean, multiple: boolean] => {
      const w = s.windows[windowId];
      const i = w && w.kind !== "private" ? s.profileOrder.indexOf(w.profileId) : -1;
      return i < 0 ? [false, false, false] : [i > 0, i < s.profileOrder.length - 1, s.profileOrder.length > 1];
    }),
  );

export const useIsFocusedWindow = (windowId: string): boolean => useBrowser((s) => focusedWindowOf(s) === windowId);
