import { useAppActive } from "../app/appActive";
import { useBrowser } from "../browser/store";
import { focusedWindowOf } from "./ui";

export function useWindowInFront(windowId: string | undefined) {
  const active = useAppActive();
  const focused = useBrowser((s) => !!windowId && focusedWindowOf(s) === windowId);
  return active && focused;
}
