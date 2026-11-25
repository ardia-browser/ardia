import { pagerFor, type PagerPage } from "./spacePager";
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
  const at = w.kind === "private" ? -1 : s.spaceOrder.indexOf(w.spaceId);
  const around = warm ? warm.map((p) => p.id) : [s.spaceOrder[at - 1], s.spaceOrder[at + 1]];
  const ids = at < 0 ? [] : around.filter((id): id is string => !!id && id !== w.spaceId && !!s.spaces[id]);
  return [engineProfile(s, w.spaceId), JSON.stringify(ids.map((id) => engineProfile(s, id))), w.spaceId];
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

export const useSpaceNeighbours = (windowId: string) =>
  useBrowser(
    useShallow((s): [previous: boolean, next: boolean, multiple: boolean] => {
      const w = s.windows[windowId];
      const i = w && w.kind !== "private" ? s.spaceOrder.indexOf(w.spaceId) : -1;
      return i < 0 ? [false, false, false] : [i > 0, i < s.spaceOrder.length - 1, s.spaceOrder.length > 1];
    }),
  );

export const useIsFocusedWindow = (windowId: string): boolean => useBrowser((s) => focusedWindowOf(s) === windowId);
