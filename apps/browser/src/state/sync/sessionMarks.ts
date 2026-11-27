import { startRebase, takeSessionBaseWrites, type ScopeState } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { newId } from "../browser/model";
import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import { isQuitting } from "../app/quit";
import { noteMissingProfiles, noteSessionRebase } from "../telemetry/syncSafetyCounts";
import { dormantLink } from "./profileLinks";
import type { SyncDoc } from "./syncDoc";
import type { SessionMarkHooks } from "./syncFiles";
import type { ConsentToken } from "../telemetry/consentPeriod";

function markSessionWith(doc: SyncDoc, mark: string) {
  doc.sessionMark = mark;
  if (!isQuitting()) foreignWriteHooks.around(() => useBrowser.setState({ syncMark: mark }));
}

export function markNewSync(doc: SyncDoc) {
  markSessionWith(doc, useBrowser.getState().syncMark || newId("sm"));
}

const holdsBase = (doc: SyncDoc) => Object.values(doc.scopes).some((scoped) => Object.keys(scoped.base).length > 0);

export function settleLaunchMark(doc: SyncDoc, consent: ConsentToken | null) {
  noteMissingProfiles(consent, Object.keys(doc.profiles).filter((id) => dormantLink(doc, id)).length);
  const here = useBrowser.getState().syncMark;
  const unmarked = doc.sessionMark === undefined;
  const stale = unmarked ? holdsBase(doc) : doc.sessionMark !== here;
  if (stale) {
    for (const state of Object.values(doc.scopes)) startRebase(state);
    doc.rebaseScopes = [...new Set([...(doc.rebaseScopes ?? []), ...Object.keys(doc.scopes)])];
    noteSessionRebase(consent);
    if (unmarked) doc.sessionMark = newId("sm");
  } else if (unmarked) {
    markSessionWith(doc, here || newId("sm"));
  }
  for (const name of doc.rebaseScopes ?? []) {
    const scoped = doc.scopes[name];
    if (scoped && !scoped.rebase) startRebase(scoped);
  }
}

function sessionMovedBeforeDurable(doc: SyncDoc, scopes: ScopeState[]): boolean {
  let moved = 0;
  for (const scoped of scopes) moved += takeSessionBaseWrites(scoped);
  if (!moved) return false;
  markSessionWith(doc, newId("sm"));
  return true;
}

function rebaseRecorded(doc: SyncDoc, names: string[]) {
  if (!doc.rebaseScopes) return;
  const left = doc.rebaseScopes.filter((name) => !names.includes(name) && doc.scopes[name]);
  if (left.length) doc.rebaseScopes = left;
  else delete doc.rebaseScopes;
}

export const sessionMarkHooks = (current: () => SyncDoc): SessionMarkHooks => ({
  moved: (scopes) => sessionMovedBeforeDurable(current(), scopes),
  saved: (names) => rebaseRecorded(current(), names),
});
