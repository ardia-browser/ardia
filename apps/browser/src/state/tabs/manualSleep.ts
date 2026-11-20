import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { inPinnedContainer } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { withSharedFamily } from "../pins/pinShare";
import { noteTabsSleptFromMenu } from "../telemetry/tabSleepCounts";
import { consentToken } from "../telemetry/client";
import { splitOf, splitTabIdsOf, withPinnedPanes } from "../splits/splits";
import { inUse } from "./loadedTabBudget";
import { hasLoadedPage } from "./pageSession";
import { shownTabIds } from "./shownTabs";
import { isSleeping } from "./sleepingTabs";

function visibleWith(s: BrowserState, id: string): boolean {
  const shown = shownTabIds(s);
  const family = withSharedFamily(s, withPinnedPanes(s, [id]));
  return family.some((x) => shown.has(x) || (splitTabIdsOf(splitOf(s, x)) ?? []).some((pane) => shown.has(pane)));
}

export function canSleep(s: BrowserState, id: string): boolean {
  const t = s.tabs[id];
  return !!t && hasLoadedPage(t) && webviews.has(id) && !isSleeping(id) && tabEngine(s, id) === "chromium" && !visibleWith(s, id);
}

export async function sleepTab(id: string, { keepProtected = false, mayWrite }: { keepProtected?: boolean; mayWrite?: () => boolean } = {}): Promise<string> {
  const s = useBrowser.getState();
  if (!s.tabs[id]) return "gone";
  if (visibleWith(s, id)) return "shown";
  const view = webviews.get(id);
  if (keepProtected) {
    if (!view) return "already";
    if (inUse(s, id)) return "kept";
    const keptBy = await view.sleepIfHidden(0).catch(() => [-1]);
    return keptBy.length ? "kept" : "asleep";
  }
  if (inPinnedContainer(s, id)) {
    if (mayWrite && !mayWrite()) return "refused";
    s.closeTabs([id]);
    return "asleep";
  }
  const outcome = view ? await view.discard().catch(() => "refused" as const) : "already";
  return outcome === "discarded" ? "asleep" : outcome;
}

export async function sleepTabsFromMenu(ids: string[], from: "tab" | "group") {
  const consent = consentToken();
  const outcomes = await Promise.all(ids.map((id) => sleepTab(id, { keepProtected: true })));
  noteTabsSleptFromMenu(from, outcomes.filter((outcome) => outcome === "kept").length, consent);
}
