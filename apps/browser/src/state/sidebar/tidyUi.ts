import { useBrowser } from "../browser/store";
import { plural } from "../browser/model";
import { canUndoTidy, pinStatesOf, tidying, untidying, type Tidied, type TidyPlan, type TidyScope } from "../pins/tidy";
import { topicModelSupported } from "../pins/topicModel";
import { topicTidyPlan } from "../pins/topicTidy";
import { noteTidyTabsRun, noteTidyTabsUndo, noteTidyTopicRun } from "../telemetry/tidyTabsCounts";
import { consentToken, counted, type ConsentToken } from "../telemetry/client";
import { showUndoToast } from "./undoToast";

const tidyingNow = new Set<string>();
const TIDYING_LISTENERS = new Set<() => void>();

export const topicTidyInFlight = (windowId: string) => tidyingNow.has(windowId);

export const onTidyingChanged = (listener: () => void) => {
  TIDYING_LISTENERS.add(listener);
  return () => TIDYING_LISTENERS.delete(listener);
};

function notifyTidying() {
  for (const listener of TIDYING_LISTENERS) listener();
}

export function tidy(windowId: string, scope: TidyScope, profileId?: string, mayWrite?: () => boolean) {
  if (scope === "tabs" && useBrowser.getState().settings.tidyTopicTabs && topicModelSupported()) {
    void tidyByTopic(windowId, profileId, consentToken(), mayWrite);
    return;
  }
  const done = applyTidy(windowId, scope, profileId);
  if (done) finishTidy(windowId, scope, done);
}

function applyTidy(windowId: string, scope: TidyScope, profileId: string | undefined, plan?: TidyPlan | null): Tidied | null {
  let tidied: Tidied | null = null;
  useBrowser.setState((s) => {
    const [next, done] = tidying(s, windowId, profileId, scope, plan);
    tidied = done;
    return next;
  });
  return tidied as Tidied | null;
}

function finishTidy(windowId: string, scope: TidyScope, done: Tidied) {
  if (scope === "tabs") noteTidyTabsRun(done.moved);
  const duplicates = done.duplicates ? `Closed ${plural(done.duplicates, done.moved ? "duplicate" : "Duplicate Pin")}` : "";
  const moved = scope === "pins" ? `Tidied ${plural(done.moved, "Pin")} into ${plural(done.groups, "Folder")}` : `Tidied ${plural(done.moved, "Tab")} into ${plural(done.groups, "Group")}`;
  const pinsAfter = pinStatesOf(useBrowser.getState(), done);
  showUndoToast(windowId, done.moved ? moved : duplicates, "sparkles", {
    message: done.moved && duplicates ? duplicates : undefined,
    undo: () => {
      useBrowser.setState((s) => untidying(s, done));
      if (scope === "tabs") noteTidyTabsUndo();
    },
    watched: (s) => [s.tabs],
    canUndo: (s) => canUndoTidy(s, pinsAfter),
  });
}

async function tidyByTopic(windowId: string, profileId: string | undefined, consent: ConsentToken | null, mayWrite?: () => boolean) {
  if (tidyingNow.has(windowId)) return;
  tidyingNow.add(windowId);
  notifyTidying();
  try {
    const plan = await topicTidyPlan(useBrowser.getState(), windowId, profileId, consent);
    if (!plan) return;
    if (mayWrite && !mayWrite()) return;
    const done = applyTidy(windowId, "tabs", profileId, plan);
    if (!done) return;
    counted(consent, () => noteTidyTopicRun());
    finishTidy(windowId, "tabs", done);
  } finally {
    tidyingNow.delete(windowId);
    notifyTidying();
  }
}
