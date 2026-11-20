import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

let runs = 0;
let kindsDone = 0;
let kindsFailed = 0;
let secretsLeft = 0;
let untitledBookmarks = 0;
let secretStops = 0;
let diaProfilesMatched = 0;
let diaProfilesWithoutFolder = 0;
let diaSidebarFiles = 0;
let diaSidebarUnreadable = 0;
let diaAppleScriptProfiles = 0;
let diaGroups = 0;
let diaSpaceProfiles = 0;
let firefoxProfiles = 0;
let firefoxFavicons = 0;
let historyImportCalls = 0;
let historyImportCallsFailed = 0;

export function noteImportRun(run: { done: number; failed: number; secretsLeft: number; withheld: number }, consent?: ConsentToken | null) {
  countFor(consent, () => {
    runs += 1;
    kindsDone += run.done;
    kindsFailed += run.failed;
    secretsLeft += run.secretsLeft;
    secretStops += run.withheld;
  }, { import_runs: 1, import_kinds_done: run.done, import_kinds_failed: run.failed, import_secrets_left: run.secretsLeft, import_withheld: run.withheld });
}

export function noteUntitledBookmarks(count: number, consent?: ConsentToken | null) {
  countFor(consent, () => {
    untitledBookmarks += count;
  }, { import_untitled_bookmarks: count });
}

export function noteDiaTabProfiles(profiles: { matched: number; withoutFolder: number }, consent?: ConsentToken | null) {
  countFor(consent, () => {
    diaProfilesMatched += profiles.matched;
    diaProfilesWithoutFolder += profiles.withoutFolder;
  }, { import_dia_profiles_matched: profiles.matched, import_dia_profiles_without_folder: profiles.withoutFolder });
}

export function noteDiaSidebar(profile: { file: boolean; unreadable: boolean; appleScript: boolean; groups: number; ownProfiles: number }, consent?: ConsentToken | null) {
  const fields = { import_dia_sidebar_files: +profile.file, import_dia_sidebar_unreadable: +profile.unreadable, import_dia_applescript_profiles: +profile.appleScript, import_dia_groups: profile.groups, import_dia_space_profiles: profile.ownProfiles };
  countFor(consent, () => {
    diaSidebarFiles += fields.import_dia_sidebar_files;
    diaSidebarUnreadable += fields.import_dia_sidebar_unreadable;
    diaAppleScriptProfiles += fields.import_dia_applescript_profiles;
    diaGroups += profile.groups;
    diaSpaceProfiles += profile.ownProfiles;
  }, fields);
}

export function noteFirefoxFavicons(icons: number, consent?: ConsentToken | null) {
  countFor(consent, () => {
    firefoxProfiles += 1;
    firefoxFavicons += icons;
  }, { import_firefox_profiles: 1, import_firefox_favicons: icons });
}

export function noteHistoryImport(batches: number, failed: number, consent?: ConsentToken | null) {
  if (!batches) return;
  countFor(consent, () => {
    historyImportCalls += batches;
    historyImportCallsFailed += failed;
  }, { import_history_batches: batches, import_history_batches_failed: failed });
}

export function takeImportRuns() {
  const taken = {
    import_runs: runs,
    import_kinds_done: kindsDone,
    import_kinds_failed: kindsFailed,
    import_secrets_left: secretsLeft,
    import_untitled_bookmarks: untitledBookmarks,
    import_withheld: secretStops,
    import_dia_profiles_matched: diaProfilesMatched,
    import_dia_profiles_without_folder: diaProfilesWithoutFolder,
    import_dia_sidebar_files: diaSidebarFiles,
    import_dia_sidebar_unreadable: diaSidebarUnreadable,
    import_dia_applescript_profiles: diaAppleScriptProfiles,
    import_dia_groups: diaGroups,
    import_dia_space_profiles: diaSpaceProfiles,
    import_firefox_profiles: firefoxProfiles,
    import_firefox_favicons: firefoxFavicons,
    import_history_batches: historyImportCalls,
    import_history_batches_failed: historyImportCallsFailed,
  };
  runs = 0;
  kindsDone = 0;
  kindsFailed = 0;
  secretsLeft = 0;
  untitledBookmarks = 0;
  secretStops = 0;
  diaProfilesMatched = 0;
  diaProfilesWithoutFolder = 0;
  diaSidebarFiles = 0;
  diaSidebarUnreadable = 0;
  diaAppleScriptProfiles = 0;
  diaGroups = 0;
  diaSpaceProfiles = 0;
  firefoxProfiles = 0;
  firefoxFavicons = 0;
  historyImportCalls = 0;
  historyImportCallsFailed = 0;
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

export function noteImportExtensionListing(listed: number, skipped: ExtensionSkipCounts, consent?: ConsentToken | null) {
  const fields = {
    import_extensions_listed: listed,
    import_extensions_skipped_installed: skipped.installed,
    import_extensions_skipped_mv2: skipped.manifestV2,
    import_extensions_skipped_unpacked: skipped.unpacked,
    import_extensions_skipped_policy: skipped.policy,
    import_extensions_skipped_external: skipped.external,
    import_extensions_skipped_not_web_store: skipped.notWebStore,
  };
  countFor(consent, () => countExtensionListing(listed, skipped), fields);
}

function countExtensionListing(listed: number, skipped: ExtensionSkipCounts) {
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

export function noteArcImport(run: { rules: number; rulesSkipped: number; archived: number; glyphIcons: number; cachedIcons: number }, consent?: ConsentToken | null) {
  const fields = { import_arc_rules: run.rules, import_arc_rules_skipped: run.rulesSkipped, import_arc_archived_tabs: run.archived, import_arc_glyph_icons: run.glyphIcons, import_arc_cached_icons: run.cachedIcons };
  countFor(consent, () => {
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) arcCounts[key] += fields[key];
  }, fields);
}

export function takeArcImportCounts() {
  const taken = { ...arcCounts };
  for (const key of Object.keys(arcCounts) as (keyof typeof arcCounts)[]) arcCounts[key] = 0;
  return taken;
}
