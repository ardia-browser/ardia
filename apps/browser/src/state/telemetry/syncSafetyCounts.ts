import { counted, type ConsentToken } from "./consentPeriod";
import { takeOpenTabSyncCounts } from "./openTabSyncCounts";

let rebases = 0;
let missingProfiles = 0;
let joinWaits = 0;
let passwordReplaces = 0;
let passwordReplaceFailures = 0;

export const noteSessionRebase = (token: ConsentToken | null) => counted(token, () => void rebases++);

export const noteMissingProfiles = (token: ConsentToken | null, count: number) => counted(token, () => void (missingProfiles = Math.max(missingProfiles, count)));

export const noteJoinWait = (token: ConsentToken | null) => counted(token, () => void joinWaits++);

export const notePasswordReplace = (token: ConsentToken | null, saved: boolean) =>
  counted(token, () => {
    passwordReplaces++;
    if (!saved) passwordReplaceFailures++;
  });

export const takeSyncDataCounts = () => ({ ...takeOpenTabSyncCounts(), ...takeSyncSafetyCounts() });

function takeSyncSafetyCounts() {
  const taken = {
    sync_session_rebases: rebases,
    sync_profiles_missing_here: missingProfiles,
    sync_join_waits: joinWaits,
    sync_password_replaces: passwordReplaces,
    sync_password_replace_failures: passwordReplaceFailures,
  };
  rebases = missingProfiles = joinWaits = passwordReplaces = passwordReplaceFailures = 0;
  return taken;
}
