let runs = 0;
let kindsDone = 0;
let kindsFailed = 0;
let secretsLeft = 0;
let diaProfilesMatched = 0;
let diaProfilesWithoutFolder = 0;
let diaSidebarFiles = 0;
let diaSidebarUnreadable = 0;
let diaAppleScriptProfiles = 0;
let diaGroups = 0;
let diaSpaceProfiles = 0;

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

export function noteDiaSidebar(profile: { file: boolean; unreadable: boolean; appleScript: boolean; groups: number; ownProfiles: number }) {
  if (profile.file) diaSidebarFiles += 1;
  if (profile.unreadable) diaSidebarUnreadable += 1;
  if (profile.appleScript) diaAppleScriptProfiles += 1;
  diaGroups += profile.groups;
  diaSpaceProfiles += profile.ownProfiles;
}

export function takeImportRuns() {
  const taken = {
    import_runs: runs,
    import_kinds_done: kindsDone,
    import_kinds_failed: kindsFailed,
    import_secrets_left: secretsLeft,
    import_dia_profiles_matched: diaProfilesMatched,
    import_dia_profiles_without_folder: diaProfilesWithoutFolder,
    import_dia_sidebar_files: diaSidebarFiles,
    import_dia_sidebar_unreadable: diaSidebarUnreadable,
    import_dia_applescript_profiles: diaAppleScriptProfiles,
    import_dia_groups: diaGroups,
    import_dia_space_profiles: diaSpaceProfiles,
  };
  runs = 0;
  kindsDone = 0;
  kindsFailed = 0;
  secretsLeft = 0;
  diaProfilesMatched = 0;
  diaProfilesWithoutFolder = 0;
  diaSidebarFiles = 0;
  diaSidebarUnreadable = 0;
  diaAppleScriptProfiles = 0;
  diaGroups = 0;
  diaSpaceProfiles = 0;
  return taken;
}
