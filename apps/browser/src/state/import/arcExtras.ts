import type { ArcArchive, ArcLinkDestination, ArcLinkRule, ArcRouting } from "../../platform/importModule";
import { newId, plural } from "../browser/model";
import { useBrowser } from "../browser/store";
import type { ClosedTab } from "../browser/types";
import { fallbackChosen, linkTextProblem, sameTarget, type AirTrafficTarget, type LinkCondition } from "../airTraffic/rules";
import { currentAirTraffic, setAirTrafficFallback, tryAddAirTrafficRule } from "../airTraffic/store";
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from "../settings/settings";
import { sessionSaved } from "../session/persist";
import { appScopeRecords } from "../sync/engine";
import { settingSyncedIn } from "../sync/settingsAdapter";
import { MAX_CLEANED } from "../pins/tabCleanup";
import { cleanedKey, keptCleanedKeys } from "../pins/importedCleaned";
import { t } from "../../lib/uiLanguage";


export const ARC_GLYPH_EMOJI: Readonly<Record<string, string>> = {
  star: "⭐",
  bookmark: "🔖",
  heart: "❤️",
  flag: "🚩",
  flash: "⚡",
  triangle: "🔺",
  medical: "✳️",
  notifications: "🔔",
  bulb: "💡",
  shapes: "🔷",
  grid: "🔲",
  apps: "🧩",
  layers: "📑",
  server: "🗄️",
  albums: "🗃️",
  copy: "📋",
  folder: "📁",
  fileTrayFull: "📥",
  calendar: "📅",
  mail: "✉️",
  checkbox: "☑️",
  document: "📄",
  book: "📖",
  chatBubbleEllipses: "💬",
  people: "👥",
  terminal: "💻",
  construction: "🛠️",
  square: "⬛",
  egg: "🥚",
  ellipse: "⚫",
  moon: "🌙",
  sunny: "☀️",
  planet: "🪐",
  leaf: "🍃",
  cloud: "☁️",
  paw: "🐾",
  bag: "🛍️",
  gift: "🎁",
  bed: "🛏️",
  restaurant: "🍴",
  barbell: "🏋️",
  airplane: "✈️",
  musicalNote: "🎵",
  colorPallete: "🎨",
  video: "🎥",
  bandage: "🩹",
  code: "🧑‍💻",
  baseball: "⚾",
  cloudOutline: "🌥️",
  map: "🗺️",
  bonfire: "🔥",
  pizza: "🍕",
  skull: "💀",
  receipt: "🧾",
  thumbsUp: "👍",
  train: "🚆",
  rss: "📡",
  search: "🔍",
  github: "🐙",
  briefcase: "💼",
};

export const ARC_UNKNOWN_GLYPH_EMOJI = "🗂️";

type SpaceLook = { emoji?: string; icon?: string };

const GLYPHS = new Map(Object.entries(ARC_GLYPH_EMOJI));

export const arcGlyphEmoji = (icon: string | undefined): string | undefined => (icon ? (GLYPHS.get(icon) ?? ARC_UNKNOWN_GLYPH_EMOJI) : undefined);

export const arcSpaceEmoji = (space: SpaceLook): string | undefined => space.emoji || arcGlyphEmoji(space.icon);

export const takesArcGlyph = (space: SpaceLook) => !space.emoji && !!space.icon;

export function withArcGlyph<T extends SpaceLook>(space: T): T {
  return takesArcGlyph(space) ? { ...space, emoji: arcGlyphEmoji(space.icon) } : space;
}

export type ArcHomes = { spaces: ReadonlyMap<string, string>; named: (name: string) => string | undefined; fallback: string };

function homeOf(to: Pick<ArcLinkDestination, "spaceId" | "spaceName">, homes: ArcHomes): string | undefined {
  return (to.spaceId && homes.spaces.get(to.spaceId)) || (to.spaceName ? homes.named(to.spaceName) : undefined);
}

export function arcLinkTarget(to: ArcLinkDestination, homes: ArcHomes): AirTrafficTarget | null {
  if (to.kind === "mostRecent") return { profileId: null, open: "tab" };
  if (!to.spaceId) return to.kind === "littleArc" ? { profileId: null, open: "littleArdia" } : null;
  const home = homeOf(to, homes);
  return home ? { profileId: home, open: to.kind === "littleArc" ? "littleArdia" : "tab" } : null;
}

export function arcLinkCondition(rule: Pick<ArcLinkRule, "match" | "text">): LinkCondition | null {
  const kind = rule.match === "equals" ? "equals" : "contains";
  return linkTextProblem(kind, rule.text) ? null : { kind, text: rule.text };
}

const ARC_RULE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const arcRuleId = (id: string) => (ARC_RULE_ID.test(id) ? `arc-${id}` : null);

const ARC_ARCHIVE_READ = 1500;

export type SettingOutcome = "none" | "applied" | "kept" | "unresolved" | "unsaved" | "same";
export type RoutingImported = { rules: number; already: number; skipped: number; unsaved: number; fallback: SettingOutcome };

function settingSet(key: SettingKey): boolean {
  const { settings, settingsMeta } = useBrowser.getState();
  const chosen = settingsMeta.chosen.includes(key) && !settingsMeta.inferred.includes(key);
  return chosen || JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]) || settingSyncedIn(appScopeRecords(), key);
}

async function savedSetting(patch: Partial<Settings>): Promise<SettingOutcome> {
  useBrowser.getState().updateSettings(patch);
  return (await sessionSaved()) ? "applied" : "unsaved";
}

async function importArcFallback(to: ArcLinkDestination | undefined, homes: ArcHomes): Promise<SettingOutcome> {
  if (!to || (to.kind === "littleArc" && !to.spaceId)) return "none";
  const target = arcLinkTarget(to, homes);
  if (!target) return "unresolved";
  const usual = target.profileId === null && target.open === "tab";
  if (usual ? !useBrowser.getState().settings.openLinksInLittleArdia : sameTarget(currentAirTraffic().fallback, target)) return "same";
  if (fallbackChosen(currentAirTraffic()) || settingSet("openLinksInLittleArdia")) return "kept";
  if (usual) return savedSetting({ openLinksInLittleArdia: false });
  return setAirTrafficFallback(target) ? "applied" : "unsaved";
}

export async function importArcRouting(routing: ArcRouting, homes: ArcHomes): Promise<RoutingImported> {
  const out: RoutingImported = { rules: 0, already: 0, skipped: routing.skipped, unsaved: 0, fallback: "none" };
  for (const rule of routing.rules) {
    const id = arcRuleId(rule.id);
    const when = arcLinkCondition(rule);
    const target = arcLinkTarget(rule.to, homes);
    if (!id || !when || !target) {
      out.skipped += 1;
      continue;
    }
    const added = tryAddAirTrafficRule({ ...target, enabled: true, from: null, when }, id);
    if ("id" in added) out.rules += 1;
    else if (added.refused === "exists") out.already += 1;
    else if (added.refused === "full") out.skipped += 1;
    else out.unsaved += 1;
  }
  out.fallback = await importArcFallback(routing.fallback, homes);
  return out;
}

async function settleUntouched<K extends SettingKey>(key: K, value: Settings[K]): Promise<SettingOutcome> {
  if (value === useBrowser.getState().settings[key]) return "same";
  if (settingSet(key)) return "kept";
  return savedSetting({ [key]: value });
}

export type ArchiveImported = { tabs: number; already: number; overQuota: number; unresolved: number; dropped: number; cleanUp: SettingOutcome };

export async function importArcArchive(archive: ArcArchive, homes: ArcHomes, now = Date.now()): Promise<ArchiveImported> {
  const have = keptCleanedKeys(useBrowser.getState());
  const seen = new Set<string>();
  const entries: ClosedTab[] = [];
  let already = 0;
  let unresolved = 0;
  for (const t of archive.tabs) {
    const profileId = t.spaceId || t.spaceName ? homeOf(t, homes) : homes.fallback;
    if (!profileId) {
      unresolved += 1;
      continue;
    }
    const entry: ClosedTab = {
      kind: "tab",
      id: newId("ct"),
      tab: { url: t.url, title: t.title, favicon: null, pin: null, muted: false, zoom: 1, customTitle: t.customTitle ?? null, customIcon: null, profileId, lastActiveAt: t.archivedAt },
      windowId: "",
      index: 0,
      group: null,
      closedAt: now - seen.size,
    };
    const key = cleanedKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entries.length + already >= MAX_CLEANED) continue;
    if (have.has(key)) already += 1;
    else entries.push(entry);
  }
  const added = entries.length ? useBrowser.getState().importCleanedTabs(entries.reverse()).added : 0;
  const minutes = archive.cleanUpAfterMinutes;
  return {
    tabs: added,
    already,
    overQuota: seen.size - added - already,
    unresolved,
    dropped: archive.dropped ?? 0,
    cleanUp: minutes === undefined ? "none" : await settleUntouched("cleanUpInactiveTabsAfterMinutes", minutes),
  };
}

export function arcNotes(routed: RoutingImported | null, archived: ArchiveImported | null): string[] {
  const notes: string[] = [];
  if (routed?.skipped)
    notes.push(`${plural(routed.skipped, "Air Traffic Control rule")} from Arc stayed behind: ${routed.skipped === 1 ? "its space or condition doesn't" : "their spaces or conditions don't"} have an exact match in Ardia.`);
  if (routed?.unsaved) notes.push(`${plural(routed.unsaved, "Air Traffic Control rule")} from Arc couldn't be saved. Try the import again.`);
  if (routed?.fallback === "unsaved" || archived?.cleanUp === "unsaved") notes.push(t(`Some of Arc's settings may not have been saved. Check Settings, or try the import again.`));
  if (routed?.fallback === "kept") notes.push(t(`Arc's choice for links from other apps wasn't imported, because you've already chosen where they open.`));
  if (routed?.fallback === "unresolved") notes.push(t(`Arc's choice for links from other apps wasn't imported: the space it named didn't come over.`));
  if (archived?.overQuota) notes.push(`${plural(archived.overQuota, "archived tab")} stayed in Arc: Recently Cleaned keeps the newest ${MAX_CLEANED} for a week.`);
  if (archived?.unresolved) notes.push(`${plural(archived.unresolved, "archived tab")} from spaces that didn't come over stayed in Arc.`);
  if (archived?.dropped) notes.push(`${plural(archived.dropped, "older archived tab")} ${archived.dropped === 1 ? "wasn't" : "weren't"} read: Ardia reads Arc's newest ${ARC_ARCHIVE_READ.toLocaleString("en-US")}.`);
  if (archived?.cleanUp === "kept") notes.push(t(`Arc's archive timing wasn't imported, because you've already set when Ardia cleans up tabs.`));
  return notes;
}
