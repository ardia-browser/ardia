import type { BrowserState } from "../browser/store";
import { innermostGroupOf, rootOf } from "../groups/groups";
import { sharedFolderOfGroup } from "../sharedFolders/removal";
import type { Op } from "./workspaceOps";
import { anchorRef, groupRef, normalWindow, OpError, space, store, tabRefs, type NameScope, type OpResult } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


export const SHARED_GROUPS_SIDEBAR_ONLY = t(`shared folder groups change only from the sidebar`);

export function sharedRoot(s: BrowserState, groupId: string): string | null {
  const root = rootOf(s.groups, groupId);
  return root && sharedFolderOfGroup(s, root.id) ? root.id : null;
}

export function sharedRootOfTab(s: BrowserState, tabId: string): string | null {
  const g = innermostGroupOf(s.groups, tabId);
  return g ? sharedRoot(s, g.id) : null;
}


function resolvedOrNull<T>(resolve: () => T): T | null {
  try {
    return resolve();
  } catch {
    return null;
  }
}

type Scope = (() => NameScope) | undefined;

function groupField(s: BrowserState, results: OpResult[], ref: unknown, scope?: Scope): string | null {
  if (ref === undefined || ref === null) return null;
  const g = resolvedOrNull(() => groupRef(results, ref, scope));
  return g ? sharedRoot(s, g.id) : null;
}

function nameScope(s: BrowserState, results: OpResult[], op: Op): Scope {
  const profileId = op.profile as string | undefined;
  const firstTab = () => tabsField(results, op.tabs)[0];
  switch (op.op) {
    case "open":
      return () => ({ windowId: space(op).windowId, profileId });
    case "tab.move":
      return () => ({ windowId: op.window !== undefined ? normalWindow(String(op.window)) : s.tabs[firstTab()!]!.windowId, profileId });
    case "group.create":
      return () => ({ windowId: op.window !== undefined || !firstTab() ? space(op).windowId : s.tabs[firstTab()!]!.windowId, profileId });
    default:
      return undefined;
  }
}

function parentOfMovedGroup(s: BrowserState, results: OpResult[], op: Op): string | null {
  const asked = resolvedOrNull(() => groupRef(results, op.group));
  if (!asked) return null;
  return groupField(s, results, op.parent, () => ({ windowId: op.window !== undefined ? normalWindow(String(op.window)) : asked.windowId, profileId: (op.profile as string | undefined) ?? asked.profileId }));
}

function insideAnchor(s: BrowserState, results: OpResult[], ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const anchor = resolvedOrNull(() => anchorRef(results, ref));
  if (!anchor) return null;
  if (anchor.kind === "tab") return sharedRootOfTab(s, anchor.id);
  const root = sharedRoot(s, anchor.id);
  return root && root !== anchor.id ? root : null;
}

function tabsField(results: OpResult[], value: unknown): string[] {
  if (Array.isArray(value)) return tabRefs(results, value as string[]);
  return typeof value === "string" ? tabRefs(results, [value]) : [];
}

function sharedTouched(s: BrowserState, results: OpResult[], op: Op): string | null {
  const members = (field: string) => tabsField(results, op[field]).map((id) => sharedRootOfTab(s, id)).find(Boolean) ?? null;
  const scope = nameScope(s, results, op);
  const destination = () => groupField(s, results, op.group, scope) ?? groupField(s, results, op.parent, scope) ?? insideAnchor(s, results, op.before) ?? insideAnchor(s, results, op.after);
  switch (op.op) {
    case "open":
      return destination();
    case "tab.move":
    case "group.create":
      return members("tabs") ?? destination();
    case "tab.pin":
    case "tab.unpin":
    case "tab.close":
      return members("tabs");
    case "tab.rename":
      return members("tab");
    case "group.update":
      return op.name !== undefined ? groupField(s, results, op.group) : null;
    case "group.move":
      return groupField(s, results, op.group) ?? parentOfMovedGroup(s, results, op) ?? insideAnchor(s, results, op.before) ?? insideAnchor(s, results, op.after);
    case "group.ungroup":
    case "group.close":
    case "group.delete":
      return groupField(s, results, op.group);
    default:
      return null;
  }
}

export function refuseSharedFolderChange(results: OpResult[], op: Op) {
  const hit = sharedTouched(store(), results, op);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSharedTabs(tabIds: string[]) {
  const s = store();
  const hit = tabIds.map((id) => sharedRootOfTab(s, id)).find(Boolean);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSyncedLinkChange(tabId: string | null | undefined, what: string) {
  const s = store();
  const t = tabId ? s.tabs[tabId] : undefined;
  if (!t || t.pinnedUrl) return;
  const hit = sharedRootOfTab(s, t.id);
  if (hit) throw new OpError("refused", `Tab ${t.id} is a link in shared folder ${hit}, and ${what} would change the link it syncs; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSharedRunCommand(command: string, tabId: string | null, targeted = false) {
  if (!tabId) return;
  if (command === "back" || command === "forward") return refuseSyncedLinkChange(tabId, command === "back" ? t(`going back`) : t(`going forward`));
  if (command !== "closeTab" && command !== "closeTabGroup") return;
  const s = store();
  const panel = s.windowUi[s.tabs[tabId]?.windowId ?? ""]?.panel;
  if (command === "closeTab" && !targeted && panel?.open && !panel.newTab) return;
  const hit = sharedRootOfTab(s, tabId);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}, so ${command} didn't run.`);
}
