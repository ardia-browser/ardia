import { activeTabId } from "../../browser/src/state/browser/model";
import { useBrowser } from "../../browser/src/state/browser/store";
import { webviews } from "../../browser/src/platform/webviews";
import { createEditTargets, documentEditPort, editField, editMenu, type EditAction, type EditMenu, type EditTarget } from "./editCommands";
import { linuxCapabilities } from "./hostCapabilities";
import { watchPageFocus, watchPageFocusRequests } from "./pageFocus";

const targets = createEditTargets();

export function startEditTargets(source: Pick<Document, "addEventListener" | "activeElement"> = document) {
  targets.focusIn(source.activeElement);
  source.addEventListener("focusin", (event) => targets.focusIn(event.target as Element | null));
  const stopFocus = watchPageFocus(targets.pageFocused);
  const stopRequests = watchPageFocusRequests(targets.pageFocused);
  return () => (stopFocus(), stopRequests());
}

type EditingPage = { edit(action: EditAction): Promise<unknown> };

function editingPage(windowId: string): EditingPage | undefined {
  const state = useBrowser.getState();
  const tabId = activeTabId(state, windowId);
  return tabId && state.tabs[tabId]?.url ? webviews.get(tabId) as unknown as EditingPage | undefined : undefined;
}

export const currentEditTarget = (): EditTarget => targets.current();
export const currentEditMenu = (windowId: string, target: EditTarget = targets.current()): EditMenu | null =>
  editMenu(target, linuxCapabilities().pageEdits && !!editingPage(windowId));

export async function runEdit(windowId: string, action: EditAction, target: EditTarget): Promise<void> {
  if (!target) return;
  if (target.kind === "field") return void await editField(target.field, action, documentEditPort());
  await editingPage(windowId)?.edit(action);
}
