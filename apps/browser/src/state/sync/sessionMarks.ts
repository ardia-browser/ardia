import { startRebase } from "../../platform/sync";
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

export function markNewSync(doc: SyncDoc) {
  const mark = useBrowser.getState().syncMark || newId("sm");
  doc.sessionMark = mark;
  useBrowser.setState({ syncMark: mark });
}

export async function settleLaunchMark(doc: SyncDoc, consent: ConsentToken | null, { checkpoint, save }: MarkFiles) {
  noteMissingProfiles(consent, Object.keys(doc.profiles).filter((id) => dormantLink(doc, id)).length);
  const stale = doc.sessionMark !== undefined && doc.sessionMark !== useBrowser.getState().syncMark;
  if (!stale && doc.sessionMark !== undefined) return;
  if (stale) {
    for (const state of Object.values(doc.scopes)) startRebase(state);
    noteSessionRebase(consent);
    if (!(await checkpoint())) return;
  }
  advanceSessionMark(doc, save);
}

export const markedAfter =
  (doc: SyncDoc, save: () => void) =>
  <Result extends { sessionBaseWrites: number }>(result: Result): Result => {
    if (result.sessionBaseWrites > 0 && !isQuitting()) advanceSessionMark(doc, save);
    return result;
  };
