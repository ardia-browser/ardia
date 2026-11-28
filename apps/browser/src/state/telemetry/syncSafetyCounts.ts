import { counted, type ConsentToken } from "./consentPeriod";
import { takeOpenTabSyncCounts } from "./openTabSyncCounts";

let rebases = 0;
let missingProfiles = 0;
let joinWaits = 0;
let passwordReplaces = 0;
let passwordReplaceFailures = 0;
let passwordAdds = 0;
let passwordAddFailures = 0;
let markSavesRefused = 0;
let startOversRefused = 0;

export const noteSessionRebase = (token: ConsentToken | null) => counted(token, () => void rebases++);

export const noteMissingProfiles = (token: ConsentToken | null, count: number) => counted(token, () => void (missingProfiles = Math.max(missingProfiles, count)));

export const noteJoinWait = (token: ConsentToken | null) => counted(token, () => void joinWaits++);

export const notePasswordReplace = (token: ConsentToken | null, saved: boolean) =>
  counted(token, () => {
    passwordReplaces++;
    if (!saved) passwordReplaceFailures++;
  });

export const notePasswordAdd = (token: ConsentToken | null, saved: boolean) =>
  counted(token, () => {
    passwordAdds++;
    if (!saved) passwordAddFailures++;
  });

export const noteMarkSaveRefused = (token: ConsentToken | null) => counted(token, () => void markSavesRefused++);

export const noteStartOverRefused = (token: ConsentToken | null) => counted(token, () => void startOversRefused++);

export const takeSyncDataCounts = () => ({ ...takeOpenTabSyncCounts(), ...takeSyncSafetyCounts() });

function takeSyncSafetyCounts() {
  const taken = {
    sync_session_rebases: rebases,
    sync_profiles_missing_here: missingProfiles,
    sync_join_waits: joinWaits,
    sync_password_replaces: passwordReplaces,
    sync_password_replace_failures: passwordReplaceFailures,
    sync_password_adds: passwordAdds,
    sync_password_add_failures: passwordAddFailures,
    sync_mark_saves_refused: markSavesRefused,
    sync_start_overs_refused: startOversRefused,
  };
  rebases = missingProfiles = joinWaits = passwordReplaces = passwordReplaceFailures = passwordAdds = passwordAddFailures = markSavesRefused = startOversRefused = 0;
  return taken;
}
