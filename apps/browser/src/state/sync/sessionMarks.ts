import { startRebase } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { newId } from "../browser/model";
import { noteMissingProfiles, noteSessionRebase } from "../telemetry/syncSafetyCounts";
import { dormantLink } from "./profileLinks";
import type { SyncDoc } from "./syncDoc";
import type { ConsentToken } from "../telemetry/consentPeriod";

export function markSession(doc: SyncDoc, { atLaunch, consent = null }: { atLaunch: boolean; consent?: ConsentToken | null }) {
  const here = useBrowser.getState().syncMark;
  if (atLaunch && doc.sessionMark !== undefined && doc.sessionMark !== here) {
    for (const state of Object.values(doc.scopes)) startRebase(state);
    noteSessionRebase(consent);
  }
  if (atLaunch) noteMissingProfiles(consent, Object.keys(doc.profiles).filter((id) => dormantLink(doc, id)).length);
  const mark = newId("sm");
  doc.sessionMark = mark;
  useBrowser.setState({ syncMark: mark });
}
