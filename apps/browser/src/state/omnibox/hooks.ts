import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";

export const useActiveTabIdWhile = (windowId: string, live: boolean): string | undefined =>
  useBrowser((s) => (live ? activeTabId(s, windowId) : undefined));
