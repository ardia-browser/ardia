import { startRebase, takeSessionBaseWrites, type ScopeState } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { newId } from "../browser/model";
import { isQuitting } from "../app/quit";
import { noteMissingProfiles, noteSessionRebase } from "../telemetry/syncSafetyCounts";
import { dormantLink } from "./profileLinks";
import type { SyncDoc } from "./syncDoc";
import type { ConsentToken } from "../telemetry/consentPeriod";

type MarkFiles = { checkpoint: () => Promise<boolean>; save: () => void };

function advanceSessionMark(doc: SyncDoc, save: () => void) {
  const mark = newId("sm");
  doc.sessionMark = mark;
  useBrowser.setState({ syncMark: mark });
  save();
}

async function rebaseSaved(doc: SyncDoc, checkpoint: () => Promise<boolean>): Promise<boolean> {
  if (!doc.rebaseUnsaved) return true;
  if (!(await checkpoint())) return false;
  delete doc.rebaseUnsaved;
  return true;
}

export function markNewSync(doc: SyncDoc) {
  const mark = useBrowser.getState().syncMark || newId("sm");
  doc.sessionMark = mark;
  useBrowser.setState({ syncMark: mark });
}

export async function settleLaunchMark(doc: SyncDoc, consent: ConsentToken | null, { checkpoint, save }: MarkFiles) {
  noteMissingProfiles(consent, Object.keys(doc.profiles).filter((id) => dormantLink(doc, id)).length);
  const stale = !!doc.rebaseUnsaved || (doc.sessionMark !== undefined && doc.sessionMark !== useBrowser.getState().syncMark);
  if (!stale && doc.sessionMark !== undefined) return;
  if (stale) {
    for (const state of Object.values(doc.scopes)) startRebase(state);
    noteSessionRebase(consent);
    doc.rebaseUnsaved = true;
    save();
  }
  if (await rebaseSaved(doc, checkpoint)) advanceSessionMark(doc, save);
}

export async function settledAfterMark(doc: SyncDoc, files: MarkFiles, state: ScopeState, settle: () => Promise<void>) {
  if (takeSessionBaseWrites(state) > 0 && !isQuitting() && (await rebaseSaved(doc, files.checkpoint))) advanceSessionMark(doc, files.save);
  return settle();
}
