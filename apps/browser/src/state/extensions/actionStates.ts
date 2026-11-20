import { extensionActionStates } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { extensionSpace, readyTabOf, tabProfile, useExtensions, windowExtensions } from "./store";
import { singleFlight } from "../../lib/singleFlight";
import { noteExtensionActionRefresh, noteExtensionActionStateFailure, noteExtensionActionStateRequest } from "../telemetry/workCounts";
import { consentToken } from "../telemetry/client";

let pendingAll = false;
const pendingSpaces = new Set<string>();

export function refreshActionStates(spaces?: Iterable<string>): Promise<void> {
  if (spaces) for (const space of spaces) pendingSpaces.add(space);
  else pendingAll = true;
  return refresh();
}

const refresh = singleFlight(async () => {
  const only = pendingAll ? null : new Set(pendingSpaces);
  pendingAll = false;
  pendingSpaces.clear();
  noteExtensionActionRefresh();
  await pass(only);
});

async function pass(only: Set<string> | null) {
  const s = useBrowser.getState();
  const { popup } = useExtensions.getState();
  await Promise.all(
    s.windowOrder.filter((windowId) => !only || only.has(extensionSpace(s, windowId))).map(async (windowId) => {
      const ids = windowExtensions(s, windowId)
        .filter((x) => x.hasAction !== false && (x.pinned || popup?.extensionId === x.id))
        .map((x) => x.id);
      const tabId = readyTabOf(activeTabId(s, windowId));
      if (!ids.length || !tabId) return;
      const consent = consentToken();
      noteExtensionActionStateRequest();
      const states = await extensionActionStates(tabId, ids, tabProfile(tabId)).catch(() => (noteExtensionActionStateFailure(consent), null));
      const previous = useExtensions.getState().actions[tabId];
      if (!states || (previous && JSON.stringify(previous) === JSON.stringify(states))) return;
      useExtensions.setState((e) => ({ actions: { ...e.actions, [tabId]: states } }));
    }),
  );
}
