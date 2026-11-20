import { ardiaError } from "@ardia/core";
import { orWarn } from "../../lib/fallback";
import { confirm } from "../app/system";
import { plural } from "../browser/model";
import { useBrowser } from "../browser/store";
import { MAX_DRAFT_LINKS } from "../groups/draftGroups";
import { createProfile } from "../profiles/actions";
import { noteImportedSpaces } from "../telemetry/usage";
import { noteDiaSidebar, noteDiaTabProfiles, noteFirefoxFavicons, noteImportRun, noteUntitledBookmarks } from "../telemetry/importRuns";
import { consentToken, type ConsentToken } from "../telemetry/client";
import {
  adoptSpaceIdentity,
  applyResult,
  emptyCounts,
  importFavorites,
  importDiaProfile,
  profileColorFor,
  profileNamed,
  type BrowserProfile,
  type DiaTabsResult,
  type ImportCounts,
  type ImportedExtension,
  type ImportKind,
  type ImportResult,
  untitledLinks,
} from "./apply";
import { diaProfilesFor, diaProfilesWithoutFolder } from "./diaTabs";
import { importArcSpace, importDiaSpace } from "./sidebarTree";
import { arcNotes, importArcArchive, importArcRouting, withArcGlyph } from "./arcExtras";
import { noteArcImport } from "../telemetry/importRuns";
import { planSidebar } from "./sidebarPlan";
import {
  APP_TAB_KINDS,
  ARC_ONCE_KINDS,
  DIA_SIDEBAR_KINDS,
  ENCRYPTED_KINDS,
  finishImport,
  importNow,
  IMPORT_KINDS,
  importSignal,
  importsBySpaces,
  patchImport,
  spacesOf,
  startProgress,
  updateStatus,
} from "./flow";
import { importModule } from "./importApi";
import { listFoundExtensions } from "./listedExtensions";
import type { ExtensionGroup } from "./extensionListing";
import { during } from "../app/jobActivity";

export function continueImport() {
  const { source, step, kinds, sourceProfiles } = importNow();
  if (!source) return;
  if (step.name === "choose") {
    if (source.needsFullDiskAccess) return patchImport({ step: { name: "access" } });
    if (source.requiresExport) return patchImport({ step: { name: "safari", error: null } });
    if (source.profiles.length > 1 || (importsBySpaces(source) && spacesOf(source).length > 1)) return patchImport({ step: { name: "profiles" } });
  }
  const sidebarKinds = DIA_SIDEBAR_KINDS.some((k) => kinds.has(k));
  const encryptedTabs = source.profiles.some((p) => sourceProfiles.includes(p.id) && p.tabsNeedKey && (kinds.has("tabs") || (!!p.diaSidebar && sidebarKinds)));
  const locked = (encryptedTabs || ENCRYPTED_KINDS.some((k) => kinds.has(k))) && source.needsKeychain && !importModule().isBrowserUnlocked(source.id);
  if ((step.name === "choose" || step.name === "profiles") && locked) return patchImport({ step: { name: "unlock", unlocking: false, error: null } });
  void runImport(kinds);
}

export async function unlockAndImport() {
  const { source, step } = importNow();
  if (!source) return;
  const signal = importSignal();
  patchImport({ step: { name: "unlock", unlocking: true, error: step.name === "unlock" ? step.error : null } });
  try {
    await importModule().unlockBrowser(source.id);
  } catch {
    if (!signal.aborted)
      patchImport({ step: { name: "unlock", unlocking: false, error: `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.` } });
    return;
  }
  if (!signal.aborted) void runImport(importNow().kinds);
}

export function skipEncryptedData() {
  const kinds = new Set(importNow().kinds);
  kinds.delete("passwords");
  kinds.delete("cookies");
  patchImport({ kinds });
  void runImport(kinds, true);
}

async function destination(target: string, index: number, name: string, color?: string, emoji?: string, shareWith?: string | null, shareTopApps?: boolean): Promise<string> {
  if (index === 0) return target;
  const clash = profileNamed(name);
  if (clash) {
    const { confirmed } = await confirm({
      title: "Import as new profile?",
      message:
        "Import this data as a new profile to avoid data loss. If you replace a profile, your passwords, cookies, and payment info will be replaced, while your bookmarks and history will be combined.",
      confirmTitle: "Import as new profile",
      cancelTitle: "Replace this profile",
    });
    if (!confirmed) return clash;
  }
  return createProfile({ name, color: profileColorFor(color), icon: emoji ?? null, shareWith, shareTopApps });
}

type AppTabs = { result: DiaTabsResult } | { note: string };

const NOT_BROUGHT = "Dia's tabs couldn't be brought over:";
const SIDEBAR_UNREAD = "Dia's sidebar file couldn't be read, so Ardia asked Dia for its open and pinned tabs: their folders, custom names and split views stay in Dia.";
const FAVORITES_LOCKED = "Dia's Favorites weren't imported: they're in its sidebar file, which needs the keychain access you skipped.";
const HELD_BACK = "what looked like a password, cookie or card number turned up where it shouldn't, so Ardia held it all back to keep it private. Importing again without passwords, cookies and cards should work.";

function readAppTabs(): Promise<AppTabs> {
  return importModule()
    .readDiaTabs()
    .then(
      (result): AppTabs => (result.windowCount ? { result } : { note: `${NOT_BROUGHT} Dia had no windows open.` }),
      (e: unknown): AppTabs => {
        const { code } = ardiaError(e);
        if (code === "locked")
          return { note: `${NOT_BROUGHT} macOS didn't allow Ardia to ask Dia for them. Allow it in System Settings › Privacy & Security › Automation, then import again.` };
        return { note: `${NOT_BROUGHT} ${code === "notRunning" ? "Dia didn't open." : "Dia didn't answer."}` };
      },
    );
}

type DiaSpacesImported = { tabs: number; groups: number; skipped: number; ownProfiles: number };

async function importDiaSpaces(
  dest: string,
  result: ImportResult,
  nextDestination: (name: string, color?: string, emoji?: string, shareWith?: string | null) => Promise<string>,
  signal: AbortSignal,
  consent: ConsentToken | null,
): Promise<DiaSpacesImported> {
  const out: DiaSpacesImported = { tabs: 0, groups: 0, skipped: 0, ownProfiles: 0 };
  const primary = result.diaSidebar ? result.diaSidebar.primarySpaceId : result.spaces[0]?.id;
  for (const space of result.spaces) {
    const into = space.id === primary ? dest : await nextDestination(space.name, space.color, undefined, dest);
    if (signal.aborted) return out;
    const r = importDiaSpace(into, space, result.favicons, consent);
    out.tabs += r.tabs;
    out.groups += r.groups;
    out.skipped += r.skipped;
    if (into !== dest) out.ownProfiles += 1;
  }
  return out;
}

function withoutKinds(result: ImportResult, kinds: ImportKind[]): ImportResult {
  return { ...result, failed: result.failed.filter((k) => !kinds.includes(k)), warnings: result.warnings.filter((w) => !w.kind || !kinds.includes(w.kind)) };
}

type AppTabsImported = { tabs: number; delivered: ReadonlySet<ImportKind> };

function importAppTabs(dest: string, tabs: AppTabs, profiles: BrowserProfile[], profileId: string, wanted: ReadonlySet<ImportKind>): AppTabsImported | null {
  if (!("result" in tabs)) return null;
  const dia = diaProfilesFor(tabs.result, profiles).get(profileId);
  if (!dia) return null;
  const delivered = new Set<ImportKind>([...(dia.pinned.length ? (["pinnedTabs"] as const) : []), ...(dia.tabs.length ? (["tabs"] as const) : [])]);
  return { tabs: importDiaProfile(dest, dia, { pinned: wanted.has("pinnedTabs"), open: wanted.has("tabs") }, tabs.result.favicons), delivered };
}

const nothingRead = (browserId: string, profileId: string, failed: ImportKind[]): ImportResult => ({
  browserId,
  profileId,
  history: [],
  historyCount: 0,
  tabs: [],
  tabGroups: [],
  credentials: [],
  cookieCount: 0,
  addressCount: 0,
  cardCount: 0,
  spaces: [],
  favorites: [],
  favicons: [],
  failed,
  warnings: [],
});

export const runImport = (wanted: ReadonlySet<ImportKind>, withoutKey = false) => during("import", () => runImportJob(wanted, withoutKey));

async function runImportJob(wanted: ReadonlySet<ImportKind>, withoutKey: boolean) {
  const { source, sourceProfiles, spaces, target } = importNow();
  if (!source) return;
  const consent = consentToken();
  const api = importModule();
  const signal = importSignal();
  const bySpaces = importsBySpaces(source);
  const selected = source.profiles.filter((p) => sourceProfiles.includes(p.id) || (bySpaces && p.spaces?.some((sp) => spaces.includes(sp.id))));
  const tabsLocked = (p: BrowserProfile) => withoutKey && !!p.tabsNeedKey;
  const requested: ImportKind[] = [...wanted].filter((k) => k !== "tabs" || !!source.asksAppForTabs || !selected.every(tabsLocked));
  if (bySpaces && requested.includes("tabs")) requested.push("spaces", "pinnedTabs");
  const order = IMPORT_KINDS.filter((k) => requested.includes(k));
  const fromApp = source.asksAppForTabs ? order.filter((k) => APP_TAB_KINDS.includes(k)) : [];
  const fromFiles = order.filter((k) => !fromApp.includes(k));
  const diaSource = !!source.asksAppForTabs || source.profiles.some((p) => p.diaSidebar);
  const sidebarKinds = diaSource ? order.filter((k) => DIA_SIDEBAR_KINDS.includes(k)) : [];
  const readsSidebarFile = (p: BrowserProfile) => !!p.diaSidebar && !withoutKey && sidebarKinds.length > 0;
  const asksApp = (p: BrowserProfile) => fromApp.length > 0 && !readsSidebarFile(p);
  const kindsFor = (p: BrowserProfile): ImportKind[] => {
    if (readsSidebarFile(p)) return order.filter((k) => fromFiles.includes(k) || sidebarKinds.includes(k));
    const files = tabsLocked(p) ? fromFiles.filter((k) => k !== "tabs") : fromFiles;
    return diaSource ? files.filter((k) => k !== "pinnedTabs" && k !== "favorites") : files;
  };
  const appUpFront = selected.some(asksApp);
  startProgress(Object.fromEntries(order.map((k) => [k, appUpFront && fromApp.includes(k) ? "active" : "pending"])), bySpaces ? Math.max(1, spaces.length) : selected.length);
  const total = emptyCounts();
  const failed = new Map<ImportKind, string[]>();
  const add = (c: ImportCounts) => (Object.keys(total) as (keyof ImportCounts)[]).forEach((k) => (total[k] += c[k]));
  let destinationIndex = 0;
  const arc = { homes: new Map<string, string>(), home: "", glyphs: 0, cachedIcons: 0, routing: undefined as ImportResult["arcRouting"], archive: undefined as ImportResult["arcArchive"] };
  const nextDestination = (name: string, color?: string, emoji?: string, shareWith?: string | null, shareTopApps?: boolean) =>
    destination(target, destinationIndex++, name, color, emoji, shareWith, shareTopApps);
  const found = new Map<string, ImportedExtension>();
  const left: string[] = [];
  let extensionsProfile = "";
  let profileDest = "";
  const extensionGroups: ExtensionGroup[] = [];
  let secretsLeft = 0;
  let withheld = 0;
  const app: { read: Promise<AppTabs> | null } = { read: null };
  const askApp = () => (app.read ??= readAppTabs());
  if (appUpFront) void askApp();
  if (source.family === "firefox" && requested.includes("passwords") && !api.isBrowserUnlocked(source.id)) {
    await api.unlockBrowser(source.id).catch(orWarn(undefined));
  }

  for (const profile of selected) {
    let result: ImportResult;
    const profileKinds = kindsFor(profile).filter((k) => !ARC_ONCE_KINDS.includes(k) || profile === selected[0]);
    if (profile.diaSidebar && !readsSidebarFile(profile) && wanted.has("favorites")) {
      failed.set("favorites", [...(failed.get("favorites") ?? []), profile.name]);
      left.push(FAVORITES_LOCKED);
    }
    try {
      result = await api.importData(source.id, profile.id, profileKinds, {
        spaceIds: bySpaces ? spaces : undefined,
        signal,
        onProgress: (p) => {
          if (p.phase === "start") updateStatus(signal, (st) => ({ ...st, [p.kind]: "active" }));
          if (p.phase === "end") updateStatus(signal, (st) => (st[p.kind] === "failed" ? st : { ...st, [p.kind]: "done" }));
        },
      });
    } catch (e) {
      const { code } = ardiaError(e);
      if (code === "cancelled") return;
      const heldBack = code === "ERR_SECRET_IN_REPLY";
      if (heldBack) left.push(`Nothing ${selected.length > 1 ? `from ${profile.name} ` : ""}was imported: ${HELD_BACK}`);
      withheld += heldBack ? 1 : 0;
      if (readsSidebarFile(profile) && fromApp.length) {
        result = nothingRead(source.id, profile.id, profileKinds);
      } else {
        for (const k of profileKinds) failed.set(k, [...(failed.get(k) ?? []), profile.name]);
        if (fromApp.length) {
          const tabs = await askApp();
          if (signal.aborted) return;
          total.tabs += importAppTabs(await nextDestination(profile.name, profile.color), tabs, source.profiles, profile.id, wanted)?.tabs ?? 0;
        }
        continue;
      }
    }
    if (signal.aborted) return;
    const sidebarMissed =
      readsSidebarFile(profile) &&
      (!result.diaSidebar || sidebarKinds.some((k) => result.failed.includes(k) || result.warnings.some((w) => w.kind === k && w.code === "empty")));
    const recoverable = sidebarMissed ? sidebarKinds.filter((k) => fromApp.includes(k)) : [];
    if (recoverable.length) {
      result = { ...withoutKinds(result, recoverable), ...(recoverable.includes("tabs") ? { tabs: [], tabGroups: [] } : {}) };
      left.push(SIDEBAR_UNREAD);
    }
    const viaApp = asksApp(profile) || recoverable.length > 0;
    const diaOutcome = { file: readsSidebarFile(profile) && !sidebarMissed, unreadable: sidebarMissed, appleScript: viaApp, groups: 0, ownProfiles: 0 };
    for (const k of result.failed) failed.set(k, [...(failed.get(k) ?? []), profile.name]);
    arc.routing ??= result.arcRouting;
    arc.archive ??= result.arcArchive;
    arc.cachedIcons += result.arcCachedIcons ?? 0;
    for (const w of result.warnings) {
      if (w.code === "undecryptable") secretsLeft += 1;
      if (w.code === "locked" || ((w.code === "undecryptable" || w.code === "skipped") && !result.failed.includes(w.kind))) left.push(`${w.message}.`);
    }
    const refused = (k: ImportKind) => {
      const names = failed.get(k) ?? [];
      if (!names.includes(profile.name)) failed.set(k, [...names, profile.name]);
    };
    if (sidebarMissed && sidebarKinds.includes("favorites")) refused("favorites");

    if (bySpaces) {
      const plan = planSidebar(source.sidebar!, result, profile.spaces);
      const members: string[][] = [];
      let startersNamed = 0;
      for (const { space: planned, partition } of plan.spaces) {
        const space = source.sidebar === "arc" ? withArcGlyph(planned) : planned;
        if (space !== planned) arc.glyphs += 1;
        const name = space.name || "Space";
        const head = members[partition]?.[0] ?? null;
        const shared = plan.sharesTopApps && plan.spaces.filter((p) => p.partition === partition).length > 1;
        const first = destinationIndex === 0;
        const dest = await nextDestination(name, space.color, space.emoji, head, shared);
        if (first && adoptSpaceIdentity(dest, space)) startersNamed += 1;
        (members[partition] ??= []).push(dest);
        arc.homes.set(space.id, dest);
        const r = importArcSpace(dest, space, result.favicons, consent);
        add({ ...emptyCounts(), tabs: r.tabs, bookmarks: r.bookmarks });
        if (r.skipped) left.push(`${plural(r.skipped, "link")} in ${name}'s folders weren't imported: each folder brings up to ${MAX_DRAFT_LINKS.toLocaleString("en-US")} links.`);
      }
      const dest = members[plan.dataPartition]?.[0] ?? (await nextDestination(result.profile?.name ?? profile.name, result.profile?.color));
      members[plan.dataPartition] ??= [dest];
      arc.home ||= dest;
      add(await applyResult(dest, { ...result, favorites: [] }, source.name, profileKinds, refused, consent));
      let essentials = 0;
      plan.favorites.forEach((tabs, partition) => {
        const group = members[partition] ?? [];
        const sharing = group.every((id) => useBrowser.getState().profiles[id]?.shareTopApps);
        const into = !plan.sharesTopApps || sharing ? group.slice(0, 1) : group;
        for (const id of into) essentials += importFavorites(id, tabs, result.favicons);
      });
      total.tabs += essentials;
      noteImportedSpaces({
        spaces: plan.spaces.length,
        containerSpaces: plan.spaces.filter((p) => p.partition !== plan.dataPartition).length,
        dataProfiles: members.filter(Boolean).length,
        essentials,
        startersNamed,
      }, consent);
      extensionsProfile ||= dest;
      profileDest = dest;
    } else {
      const dest = await nextDestination(result.profile?.name ?? profile.name, result.profile?.color ?? profile.color);
      add(await applyResult(dest, result, source.name, profileKinds, refused, consent));
      if (readsSidebarFile(profile) && !sidebarMissed && result.spaces.length) {
        const r = await importDiaSpaces(dest, result, nextDestination, signal, consent);
        if (signal.aborted) return;
        total.tabs += r.tabs;
        diaOutcome.groups = r.groups;
        diaOutcome.ownProfiles = r.ownProfiles;
        if (r.skipped) left.push(`${plural(r.skipped, "link")} in Dia's folders weren't imported: each folder brings up to ${MAX_DRAFT_LINKS.toLocaleString("en-US")} links.`);
      }
      if (viaApp) {
        const tabs = await askApp();
        if (signal.aborted) return;
        const brought = importAppTabs(dest, tabs, source.profiles, profile.id, wanted);
        recoverable.filter((k) => !brought?.delivered.has(k)).forEach(refused);
        total.tabs += brought?.tabs ?? 0;
      }
      extensionsProfile ||= dest;
      profileDest = dest;
    }
    if (diaSource && sidebarKinds.length) noteDiaSidebar(diaOutcome, consent);
    noteUntitledBookmarks(untitledLinks(result.bookmarks), consent);
    if (source.family === "firefox") noteFirefoxFavicons(result.favicons.length, consent);
    if (source.family === "chromium" || source.family === "arc") {
      const list = await api.listExtensions(source.id, profile.id).catch(orWarn([]));
      for (const e of list) if (!e.skip) found.set(e.id, e);
      extensionGroups.push({ sourceProfile: profile.name, profileId: profileDest, list });
    }
  }
  if (signal.aborted) return;
  if (source.family === "arc") {
    const homes = { spaces: arc.homes, named: profileNamed, fallback: arc.home || target };
    const routed = arc.routing ? await importArcRouting(arc.routing, homes) : null;
    const archived = arc.archive ? await importArcArchive(arc.archive, homes) : null;
    total.rules += routed?.rules ?? 0;
    total.archived += archived?.tabs ?? 0;
    total.settings += [routed?.fallback, archived?.cleanUp].filter((o) => o === "applied").length;
    left.push(...arcNotes(routed, archived));
    noteArcImport({ rules: routed?.rules ?? 0, rulesSkipped: routed?.skipped ?? 0, archived: archived?.tabs ?? 0, glyphIcons: arc.glyphs, cachedIcons: arc.cachedIcons }, consent);
  }
  const appTabsResult = app.read && (await app.read);
  if (signal.aborted) return;
  if (appTabsResult) {
    const note = "note" in appTabsResult ? appTabsResult.note : null;
    if (note) left.push(note);
    if ("result" in appTabsResult) {
      const kinds = { pinned: wanted.has("pinnedTabs"), open: wanted.has("tabs") };
      const extra = diaProfilesWithoutFolder(appTabsResult.result, source.profiles, kinds);
      for (const dia of extra) {
        const dest = await nextDestination(dia.name);
        if (signal.aborted) return;
        total.tabs += importDiaProfile(dest, dia, kinds, appTabsResult.result.favicons);
      }
      noteDiaTabProfiles({ matched: diaProfilesFor(appTabsResult.result, source.profiles).size, withoutFolder: extra.length }, consent);
    }
    updateStatus(signal, (st) => ({ ...st, ...Object.fromEntries(fromApp.map((k) => [k, note ? "failed" : "done"])) }));
  }
  updateStatus(signal, (st) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, failed.has(k as ImportKind) ? "failed" : v === "failed" ? v : "done"])));
  api.forgetUnlockedKeys();
  noteImportRun({ done: order.filter((k) => !failed.has(k)).length, failed: failed.size, secretsLeft, withheld }, consent);
  if (total.bookmarks > 0) useBrowser.getState().updateSettings({ bookmarksImportDismissed: true });
  const listing = await listFoundExtensions(extensionGroups, consent).catch(orWarn(null));
  if (signal.aborted) return;
  finishImport(signal, {
    counts: total,
    failures: [...failed].map(([kind, names]) => ({ kind, profiles: selected.length > 1 ? names : [] })),
    notes: [...new Set(left)],
    extensions: { profileId: extensionsProfile, list: [...found.values()], opened: false, listing },
  });
}

