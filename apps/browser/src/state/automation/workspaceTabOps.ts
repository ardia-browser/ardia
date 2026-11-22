import { inPinnedContainer, isPinnedRow } from "../browser/model";
import { NO_GROUP_ICON } from "../groups/groupIcons";
import { NO_ROW_ICON } from "../pins/rowIcons";
import { isSiteMuted } from "../tabs/mute";
import { needsPage, wokenPage } from "../tabs/pageSession";
import { sleepTab } from "../tabs/manualSleep";
import { isSleeping } from "../tabs/sleepingTabs";
import { webviews } from "../../platform/webviews";
import type { WebViewHandle } from "../../platform/tabs";
import { withDeadline } from "../../lib/deadline";
import { awaitLate } from "./tabCalls";
import type { IconValue, Op } from "./workspaceOps";
import { OpError, store, tabRef, tabRefs, type OpResult } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


const str = (v: unknown) => v as string;

export function mute(results: OpResult[], op: Op, muted: boolean): OpResult {
  const ids = tabRefs(results, op.tabs as string[]);
  for (const id of ids) {
    const s = store();
    if (!muted && isSiteMuted(s, s.tabs[id]!)) s.setSiteMuted(id, false);
    if (store().tabs[id]!.muted !== muted) store().setMuted([id], muted);
    if (store().tabs[id]?.muted !== muted) throw new OpError("failed", `Ardia didn't do that: tab ${id} isn't ${muted ? "muted" : "unmuted"}.`);
  }
  return { tabs: ids };
}

export const NATIVE_DEADLINE_MS = 10_000;

const LATE = Symbol("late");

function stopped(message: string, done: string[]) {
  const error = new OpError("failed", message);
  if (done.length) error.changed = { tabs: [...done] };
  return error;
}

const CHANGED = new Set(["asleep", "awake", "loading"]);

async function settled(work: Promise<string>, id: string, doing: string, done: string[], stillOn: () => boolean, owner: number): Promise<string> {
  const outcome = await withDeadline(work, NATIVE_DEADLINE_MS, LATE);
  if (outcome === LATE) {
    awaitLate(id, work, { connection: owner, serving: stillOn });
    throw stopped(`Tab ${id} didn't finish ${doing} within ${NATIVE_DEADLINE_MS / 1000} s: outcome unknown. Ardia stopped waiting; the tab is busy until the engine answers, and a later batch reports what happened under late.`, done);
  }
  if (!stillOn()) throw stopped(`Control was turned off while tab ${id} was ${doing}; the tabs after it were left alone.`, CHANGED.has(outcome) ? [...done, id] : done);
  return outcome;
}

function goingOn(stillOn: () => boolean, done: string[]) {
  if (!stillOn()) throw stopped(t(`Control was turned off during this op; the tabs after the ones in changed were left alone.`), done);
}

export async function sleep(results: OpResult[], op: Op, stillOn: () => boolean = () => true, owner = 0): Promise<OpResult> {
  const ids = tabRefs(results, op.tabs as string[]);
  const outcomes: Record<string, string> = {};
  const done: string[] = [];
  for (const id of ids) {
    goingOn(stillOn, done);
    outcomes[id] = await settled(sleepTab(id, { mayWrite: stillOn }), id, t(`going to sleep`), done, stillOn, owner);
    if (CHANGED.has(outcomes[id]!)) done.push(id);
  }
  return { tabs: ids, outcomes };
}

async function attachment(view: WebViewHandle): Promise<boolean | null> {
  try {
    const known = await view.isAttached?.();
    return typeof known === "boolean" ? known : null;
  } catch {
    return null;
  }
}

async function reloadChecked(view: WebViewHandle, stillOn: () => boolean): Promise<string> {
  if ((await attachment(view)) === false) return "no_view";
  if (!stillOn()) return "stopped";
  const reloaded = await view.reload().then(
    () => true,
    () => false,
  );
  const after = await attachment(view);
  if (after === false) return "no_view";
  if (!reloaded) return "failed";
  return after === true ? "awake" : "reload_unverified";
}

export async function wake(results: OpResult[], op: Op, stillOn: () => boolean = () => true, owner = 0): Promise<OpResult> {
  const ids = tabRefs(results, op.tabs as string[]);
  const outcomes: Record<string, string> = {};
  const done: string[] = [];
  for (const id of ids) {
    goingOn(stillOn, done);
    const t = store().tabs[id];
    if (!t) outcomes[id] = "gone";
    else if (isSleeping(id) && !webviews.get(id)) outcomes[id] = "no_view";
    else if (isSleeping(id)) outcomes[id] = await settled(reloadChecked(webviews.get(id)!, stillOn), id, "waking", done, stillOn, owner);
    else if (needsPage(t)) {
      store().updateTab(id, { page: wokenPage(t) });
      outcomes[id] = "loading";
    } else outcomes[id] = "already";
    if (CHANGED.has(outcomes[id]!)) done.push(id);
  }
  return { tabs: ids, outcomes };
}

export function closeTabs(results: OpResult[], op: Op): OpResult {
  const ids = tabRefs(results, op.tabs as string[]);
  store().closeTabs(ids);
  const s = store();
  const left = ids.find((id) => s.tabs[id] && !inPinnedContainer(s, id));
  if (left) throw new OpError("failed", `Ardia didn't do that: tab ${left} is still open.`);
  return { tabs: ids };
}

export function rename(results: OpResult[], op: Op): OpResult {
  const id = tabRef(results, str(op.tab));
  const t = store().tabs[id]!;
  const name = (op.title as string | null) ?? "";
  const customTitle = name && name !== t.title ? name : null;
  store().updateTab(id, { customTitle });
  if (store().tabs[id]?.customTitle !== customTitle) throw new OpError("failed", `Ardia didn't do that: tab ${id} wasn't renamed.`);
  return { tabs: [id] };
}

export function tabIcon(results: OpResult[], op: Op): OpResult {
  const id = tabRef(results, str(op.tab));
  const none = op.icon === NO_GROUP_ICON;
  if (none && !isPinnedRow(store().tabs[id])) throw new OpError("bad_request", t(`"none" is for groups and pinned rows; give null to reset a tab's icon.`));
  const icon = none ? NO_ROW_ICON : (op.icon as IconValue);
  store().updateTab(id, { customIcon: icon });
  if (store().tabs[id]?.customIcon !== icon) throw new OpError("failed", `Ardia didn't do that: tab ${id}'s icon didn't change.`);
  return { tabs: [id] };
}
