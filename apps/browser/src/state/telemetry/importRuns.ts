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
let firefoxProfiles = 0;
let firefoxFavicons = 0;

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

export function noteFirefoxFavicons(icons: number) {
  firefoxProfiles += 1;
  firefoxFavicons += icons;
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
    import_firefox_profiles: firefoxProfiles,
    import_firefox_favicons: firefoxFavicons,
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
  firefoxProfiles = 0;
  firefoxFavicons = 0;
  return { ...taken, ...takeImportExtensionCounts() };
}

const extensionCounts = {
  import_extensions_listed: 0,
  import_extension_store_pages_opened: 0,
  import_extensions_skipped_installed: 0,
  import_extensions_skipped_mv2: 0,
  import_extensions_skipped_unpacked: 0,
  import_extensions_skipped_policy: 0,
  import_extensions_skipped_external: 0,
  import_extensions_skipped_not_web_store: 0,
};

type ExtensionSkipCounts = { installed: number; manifestV2: number; unpacked: number; policy: number; external: number; notWebStore: number };

export function noteImportExtensionListing(listed: number, skipped: ExtensionSkipCounts) {
  extensionCounts.import_extensions_listed += listed;
  extensionCounts.import_extensions_skipped_installed += skipped.installed;
  extensionCounts.import_extensions_skipped_mv2 += skipped.manifestV2;
  extensionCounts.import_extensions_skipped_unpacked += skipped.unpacked;
  extensionCounts.import_extensions_skipped_policy += skipped.policy;
  extensionCounts.import_extensions_skipped_external += skipped.external;
  extensionCounts.import_extensions_skipped_not_web_store += skipped.notWebStore;
}

export function noteImportExtensionStorePages(opened: number) {
  extensionCounts.import_extension_store_pages_opened += opened;
}

function takeImportExtensionCounts() {
  const taken = { ...extensionCounts };
  for (const key of Object.keys(extensionCounts) as (keyof typeof extensionCounts)[]) extensionCounts[key] = 0;
  return taken;
}

const arcCounts = { import_arc_rules: 0, import_arc_rules_skipped: 0, import_arc_archived_tabs: 0, import_arc_glyph_icons: 0, import_arc_cached_icons: 0 };

export function noteArcImport(run: { rules: number; rulesSkipped: number; archived: number; glyphIcons: number; cachedIcons: number }) {
  arcCounts.import_arc_rules += run.rules;
  arcCounts.import_arc_rules_skipped += run.rulesSkipped;
  arcCounts.import_arc_archived_tabs += run.archived;
  arcCounts.import_arc_glyph_icons += run.glyphIcons;
  arcCounts.import_arc_cached_icons += run.cachedIcons;
}

export function takeArcImportCounts() {
  const taken = { ...arcCounts };
  for (const key of Object.keys(arcCounts) as (keyof typeof arcCounts)[]) arcCounts[key] = 0;
  return taken;
}
