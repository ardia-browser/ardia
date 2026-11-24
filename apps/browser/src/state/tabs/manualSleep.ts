import { webviews } from "../../platform/webviews";
import { useBrowser, type BrowserState } from "../browser/store";
import { inPinnedContainer } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { withSharedFamily } from "../pins/pinShare";
import { noteTabsSleptFromMenu } from "../telemetry/tabSleepCounts";
import { keptAwakeReason, onlyAutomaticProtections, type KeptAwakeReason } from "./sleepRefusals";
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

type MenuSleep = { outcome: string; keptBy?: KeptAwakeReason; pastAutomatic?: boolean };

export async function sleepAsked(id: string, stillWanted: () => boolean = () => true): Promise<MenuSleep> {
  const s = useBrowser.getState();
  if (!s.tabs[id]) return { outcome: "gone" };
  if (visibleWith(s, id)) return { outcome: "shown" };
  const view = webviews.get(id);
  if (!view) return { outcome: "already" };
  if (inUse(s, id)) return { outcome: "kept", keptBy: "playingOrSharing" };
  if (!stillWanted()) return { outcome: "dropped" };
  const keptBy = await view.sleepIfHidden(0).catch(() => [-1]);
  if (!keptBy.length) return { outcome: "asleep" };
  if (!onlyAutomaticProtections(keptBy)) return { outcome: "kept", keptBy: keptAwakeReason(keptBy) };
  const after = useBrowser.getState();
  if (!after.tabs[id] || webviews.get(id) !== view) return { outcome: "gone" };
  if (visibleWith(after, id)) return { outcome: "shown" };
  if (inUse(after, id)) return { outcome: "kept", keptBy: "playingOrSharing" };
  if (!stillWanted()) return { outcome: "dropped" };
  const discarded = await view.discard().catch(() => "refused" as const);
  if (discarded === "already") return { outcome: "asleep" };
  return discarded === "discarded" ? { outcome: "asleep", pastAutomatic: true } : { outcome: "kept", keptBy: "other" };
}

export async function sleepTab(id: string, { mayWrite }: { mayWrite?: () => boolean } = {}): Promise<string> {
  const s = useBrowser.getState();
  if (!s.tabs[id]) return "gone";
  if (visibleWith(s, id)) return "shown";
  const view = webviews.get(id);
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
  const results = await Promise.all(ids.map((id) => sleepAsked(id)));
  noteTabsSleptFromMenu(from, results, consent);
}
