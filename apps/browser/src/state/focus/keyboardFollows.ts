import { followKeyboard, type FollowKeyboard } from "../../platform/keyboardFollow";
import { useBrowser } from "../browser/store";
import type { BrowserState } from "../browser/store";

type Followed = Pick<BrowserState, "windows" | "peeks" | "tabs">;
type Store = { getState(): Followed; subscribe(listener: (state: Followed, prev: Followed) => void): () => void };

const shownTabOf = (s: Followed, windowId: string) => {
  const w = s.windows[windowId];
  return w ? w.activeTabIds[w.spaceId] : undefined;
};

const peekShownIn = (s: Followed, windowId: string) => {
  const source = shownTabOf(s, windowId);
  const peek = source ? s.peeks[source]?.tabId : undefined;
  return peek && s.tabs[peek]?.windowId === windowId ? peek : undefined;
};

const gotItsFirstPage = (s: Followed, prev: Followed, tabId: string) => !!s.tabs[tabId]?.url && !prev.tabs[tabId]?.url;

export function startKeyboardFollows(follow: FollowKeyboard | null = followKeyboard, store: Store = useBrowser): () => void {
  if (!follow) return () => {};
  return store.subscribe((s, prev) => {
    if (s.windows === prev.windows && s.peeks === prev.peeks && s.tabs === prev.tabs) return;
    for (const windowId of Object.keys(s.windows)) {
      const shown = shownTabOf(s, windowId);
      if (shown && (shown !== shownTabOf(prev, windowId) || gotItsFirstPage(s, prev, shown))) follow(shown, windowId);
      const peek = peekShownIn(s, windowId);
      if (peek && peek !== peekShownIn(prev, windowId)) follow(peek, windowId);
    }
  });
}

export function followHandedBack(windowId: string, follow: FollowKeyboard | null = followKeyboard, store: Pick<Store, "getState"> = useBrowser): void {
  const s = store.getState();
  const tabId = peekShownIn(s, windowId) ?? shownTabOf(s, windowId);
  if (follow && tabId) follow(tabId, windowId);
}
