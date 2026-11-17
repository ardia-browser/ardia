let runs = 0;
let kindsDone = 0;
let kindsFailed = 0;
let secretsLeft = 0;
let diaProfilesMatched = 0;
let diaProfilesWithoutFolder = 0;

export function noteImportRun(run: { done: number; failed: number; secretsLeft: number }) {
  runs += 1;
  kindsDone += run.done;
  kindsFailed += run.failed;
  secretsLeft += run.secretsLeft;
}

export function noteDiaTabProfiles(profiles: { matched: number; withoutFolder: number }) {
  diaProfilesMatched += profiles.matched;
  diaProfilesWithoutFolder += profiles.withoutFolder;
}

export function takeImportRuns() {
  const taken = {
    import_runs: runs,
    import_kinds_done: kindsDone,
    import_kinds_failed: kindsFailed,
    import_secrets_left: secretsLeft,
    import_dia_profiles_matched: diaProfilesMatched,
    import_dia_profiles_without_folder: diaProfilesWithoutFolder,
  };
  runs = 0;
  kindsDone = 0;
  kindsFailed = 0;
  secretsLeft = 0;
  diaProfilesMatched = 0;
  diaProfilesWithoutFolder = 0;
  return taken;
}
