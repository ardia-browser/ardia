import { useBrowser } from "../browser/store";
import { keyedWatch, recordWatch, useKeyed } from "../browser/keyedWatch";
import { useTab } from "../browser/hooks";
import { nestedOpener, pinChildIndex, type PinChildIndex } from "./pinChildren";

let heard: PinChildIndex | null = null;

const wakeChanged = (from: PinChildIndex, to: PinChildIndex, wake: (id: string) => void) => {
  for (const [opener, kids] of from) if (to.get(opener) !== kids) for (const kid of kids) wake(kid);
};

const watchNestedOpeners = keyedWatch(
  () => useBrowser,
  (s, prev, wake) => {
    const was = heard ?? pinChildIndex(prev);
    const next = pinChildIndex(s);
    heard = next;
    if (next === was) return;
    wakeChanged(was, next, wake);
    wakeChanged(next, was, wake);
  },
);

const watchProfileRecord = recordWatch(() => useBrowser, (s) => s.profiles);

export const useNestedOpener = (tabId: string) => useKeyed(watchNestedOpeners, tabId, () => nestedOpener(useBrowser.getState(), tabId));

export function useNestIndent(tabId: string, nestedUnder: string | undefined, inFolder: boolean): boolean {
  const profileId = useTab(tabId, (t) => t?.profileId);
  const collapsed = useKeyed(watchProfileRecord, nestedUnder && !inFolder ? profileId : null, () => !!useBrowser.getState().profiles[profileId ?? ""]?.pinnedCollapsed);
  return !!nestedUnder && (inFolder || !collapsed);
}
