import type { ArcArchive, ArcRouting, SpaceSuggestion, SpaceSummary } from "@ardia/import";
import { parseArcSidebar, type ArcSidebar } from "./arcSidebar";
import { ARC_ARCHIVE_FILE, ARC_ROUTING_FILE, ARCHIVE_BYTES, changesFallback, parseArcArchive, parseArcRouting, ROUTING_BYTES } from "./arcExtras";
import { exists, join, type ImportHost } from "./host";
import { ImportFailure, linkCount, type ImportKind, type Profile, type Result } from "./model";
import { loadZenSidebar, zenContainerNames, type ZenSidebar } from "./zenSidebar";

const ARC_DIR = "Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc";
export const ARC_SIDEBAR_FILE = `${ARC_DIR}\\StorableSidebar.json`;

const LARGEST_SIDEBAR_BYTES = 64 << 20;

export const arcSidebarPath = (host: ImportHost) => join(host.localAppData, ARC_SIDEBAR_FILE);

export const arcFilePath = (host: ImportHost, ...name: string[]) => join(host.localAppData, ARC_DIR, ...name);

export const arcSpaceNames = (sidebar: ArcSidebar | null | undefined) => new Map((sidebar?.spaces ?? []).map((s) => [s.id, s.name]));

export async function readArcRouting(host: ImportHost, sidebar: ArcSidebar | null): Promise<ArcRouting> {
  const raw = await host.readTextWithin(arcFilePath(host), arcFilePath(host, ARC_ROUTING_FILE), ROUTING_BYTES).catch(() => null);
  if (raw === null) throw new ImportFailure("notFound", "No readable Arc Air Traffic Control rules");
  return parseArcRouting(raw, arcSpaceNames(sidebar));
}

export async function readArcArchive(host: ImportHost, sidebar: ArcSidebar | null): Promise<ArcArchive> {
  const raw = await host.readTextWithin(arcFilePath(host), arcFilePath(host, ARC_ARCHIVE_FILE), ARCHIVE_BYTES).catch(() => null);
  if (raw === null && (await exists(host, arcFilePath(host), ARC_ARCHIVE_FILE))) throw new ImportFailure("unreadable", "Arc's archive couldn't be read");
  return parseArcArchive(raw, null, arcSpaceNames(sidebar));
}

async function arcExtraKinds(host: ImportHost, sidebar: ArcSidebar | null): Promise<ImportKind[]> {
  const kinds: ImportKind[] = [];
  const routing = await readArcRouting(host, sidebar).catch(() => null);
  if (routing && (routing.rules.length || routing.skipped || changesFallback(routing))) kinds.push("linkRules");
  if (await exists(host, arcFilePath(host), ARC_ARCHIVE_FILE)) kinds.push("archive");
  return kinds;
}

export async function loadArcSidebar(host: ImportHost): Promise<ArcSidebar> {
  const raw = await host.readTextWithin(arcFilePath(host), arcSidebarPath(host), LARGEST_SIDEBAR_BYTES).catch(() => null);
  if (raw == null) throw new ImportFailure("notFound", "No Arc sidebar data");
  return parseArcSidebar(raw);
}

const pinnedCount = (space: SpaceSuggestion) => space.pinned.reduce((n, node) => n + linkCount(node), 0);

export function spaceSummaries(spaces: SpaceSuggestion[], containers?: Map<number, string>): SpaceSummary[] {
  return spaces.map((s) => {
    const containerName = s.container !== undefined ? containers?.get(s.container) : undefined;
    return {
      id: s.id,
      name: s.name,
      ...(s.color !== undefined ? { color: s.color } : {}),
      ...(s.emoji !== undefined ? { emoji: s.emoji } : {}),
      ...(s.icon !== undefined ? { icon: s.icon } : {}),
      pinnedCount: pinnedCount(s),
      tabCount: s.tabs.length,
      ...(s.theme !== undefined ? { theme: s.theme } : {}),
      ...(s.container !== undefined ? { container: s.container } : {}),
      ...(containerName !== undefined ? { containerName } : {}),
    };
  });
}

export async function attachArcSpaces(host: ImportHost, profiles: Profile[]): Promise<Profile[]> {
  const sidebar = await loadArcSidebar(host).catch(() => null);
  const extras = await arcExtraKinds(host, sidebar);
  if (!sidebar) return profiles.map((profile) => ({ ...profile, available: [...profile.available, ...extras] }));
  return profiles.map((profile) => {
    const spaces = sidebar.spaces.filter((s) => s.profileId === profile.id);
    const kinds: ImportKind[] = [...profile.available, ...extras];
    if (spaces.length) kinds.push("spaces", "pinnedTabs", "tabs");
    if (sidebar.favorites[profile.id]?.length) kinds.push("favorites");
    return { ...profile, spaces: spaceSummaries(spaces), available: kinds };
  });
}

export async function zenProfileSpaces(host: ImportHost, dir: string, profileId: string, kinds: ImportKind[]): Promise<SpaceSummary[] | undefined> {
  const sidebar = await loadZenSidebar(host, dir, profileId).catch(() => null);
  if (!sidebar?.spaces.length) return undefined;
  kinds.push("spaces", "pinnedTabs");
  if (!kinds.includes("tabs")) kinds.push("tabs");
  if (sidebar.essentials.length) kinds.push("favorites");
  return spaceSummaries(sidebar.spaces, await zenContainerNames(host, dir).catch(() => new Map<number, string>()));
}

export class Sidebars {
  private arc?: ArcSidebar;
  private zen?: ZenSidebar;
  private readonly host: ImportHost;
  private readonly dir: string;
  private readonly profileId: string;
  private readonly cancelled: () => boolean;

  constructor(host: ImportHost, dir: string, profileId: string, cancelled: () => boolean) {
    this.host = host;
    this.dir = dir;
    this.profileId = profileId;
    this.cancelled = cancelled;
  }

  async arcSidebar(): Promise<ArcSidebar> {
    this.arc ??= await loadArcSidebar(this.host);
    return this.arc;
  }

  async zenSidebar(): Promise<ZenSidebar> {
    this.zen ??= await loadZenSidebar(this.host, this.dir, this.profileId, this.cancelled);
    return this.zen;
  }

  loadedZen() {
    return this.zen;
  }

  loadedArc() {
    return this.arc;
  }

  async spaces(sidebar: "arc" | "zen" | undefined): Promise<SpaceSuggestion[] | undefined> {
    if (sidebar === "arc") return (await this.arcSidebar()).spaces.filter((s) => s.profileId === this.profileId);
    if (sidebar === "zen") {
      const spaces = (await this.zenSidebar().catch(() => null))?.spaces ?? [];
      return spaces.length ? spaces : undefined;
    }
    return undefined;
  }
}

export function takeSpaces(result: Result, all: SpaceSuggestion[], kind: ImportKind, kinds: ImportKind[], spaceIds: string[] | undefined): number {
  const spaces = all.filter((s) => spaceIds?.includes(s.id) ?? true);
  result.spaces = spaces.map((s) => ({ ...s, pinned: kinds.includes("pinnedTabs") ? s.pinned : [], tabs: kinds.includes("tabs") ? s.tabs : [] }));
  if (kind === "tabs") {
    result.tabs = spaces.flatMap((s) => s.tabs);
    return result.tabs.length;
  }
  if (kind === "pinnedTabs") return spaces.reduce((n, s) => n + pinnedCount(s), 0);
  return spaces.length;
}
