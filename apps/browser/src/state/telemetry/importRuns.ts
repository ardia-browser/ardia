import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

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
let searchEngineOffersTaken = 0;
let historyImportCalls = 0;
let historyImportCallsFailed = 0;

export function noteImportRun(run: { done: number; failed: number; secretsLeft: number; withheld: number }, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    runs += 1;
    kindsDone += run.done;
    kindsFailed += run.failed;
    secretsLeft += run.secretsLeft;
    secretStops += run.withheld;
  });
}

export function noteUntitledBookmarks(count: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    untitledBookmarks += count;
  });
}

export function noteDiaTabProfiles(profiles: { matched: number; withoutFolder: number }, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    diaProfilesMatched += profiles.matched;
    diaProfilesWithoutFolder += profiles.withoutFolder;
  });
}

export function noteDiaSidebar(profile: { file: boolean; unreadable: boolean; appleScript: boolean; groups: number; ownProfiles: number }, consent?: ConsentToken | null) {
  const fields = { import_dia_sidebar_files: +profile.file, import_dia_sidebar_unreadable: +profile.unreadable, import_dia_applescript_profiles: +profile.appleScript, import_dia_groups: profile.groups, import_dia_space_profiles: profile.ownProfiles };
  countFor(consentOrNow(consent), () => {
    diaSidebarFiles += fields.import_dia_sidebar_files;
    diaSidebarUnreadable += fields.import_dia_sidebar_unreadable;
    diaAppleScriptProfiles += fields.import_dia_applescript_profiles;
    diaGroups += profile.groups;
    diaSpaceProfiles += profile.ownProfiles;
  });
}

export function noteFirefoxFavicons(icons: number, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    firefoxProfiles += 1;
    firefoxFavicons += icons;
  });
}

export function noteSearchEngineOfferTaken() {
  searchEngineOffersTaken += 1;
}

export function noteHistoryImport(batches: number, failed: number, consent?: ConsentToken | null) {
  if (!batches) return;
  countFor(consentOrNow(consent), () => {
    historyImportCalls += batches;
    historyImportCallsFailed += failed;
  });
}

type ImportCoreRead = { format: string; backend: string; outcome: string };

const coreCounts = {
  import_core_chromium_bookmarks_rust: 0,
  import_core_chromium_bookmarks_native: 0,
  import_core_chromium_bookmarks_unreadable: 0,
  import_core_chromium_bookmarks_too_large: 0,
};

export function noteImportCore(reads: readonly ImportCoreRead[] | undefined, consent?: ConsentToken | null) {
  const chromium = (reads ?? []).filter((read) => read.format === "chromium_bookmarks" && read.outcome !== "notFound");
  if (!chromium.length) return;
  countFor(consentOrNow(consent), () => {
    for (const read of chromium) {
      if (read.backend === "rust") coreCounts.import_core_chromium_bookmarks_rust += 1;
      else coreCounts.import_core_chromium_bookmarks_native += 1;
      if (read.outcome === "unreadable" || read.outcome === "argument") coreCounts.import_core_chromium_bookmarks_unreadable += 1;
      if (read.outcome === "tooLarge") coreCounts.import_core_chromium_bookmarks_too_large += 1;
    }
  });
}

function takeImportCoreCounts() {
  const taken = { ...coreCounts };
  for (const key of Object.keys(coreCounts) as (keyof typeof coreCounts)[]) coreCounts[key] = 0;
  return taken;
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
    import_search_engine_offers_taken: searchEngineOffersTaken,
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
  searchEngineOffersTaken = 0;
  historyImportCalls = 0;
  historyImportCallsFailed = 0;
  return { ...taken, ...takeImportExtensionCounts(), ...takeImportCoreCounts() };
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
  countFor(consentOrNow(consent), () => countExtensionListing(listed, skipped));
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
  countFor(consentOrNow(consent), () => {
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) arcCounts[key] += fields[key];
  });
}

export function takeArcImportCounts() {
  const taken = { ...arcCounts };
  for (const key of Object.keys(arcCounts) as (keyof typeof arcCounts)[]) arcCounts[key] = 0;
  return taken;
}
