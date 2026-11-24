export type IncomingLink =
  | { kind: "open"; url: string; source?: string }
  | { kind: "search"; query: string | null }
  | { kind: "voiceSearch" }
  | { kind: "incognito" }
  | { kind: "tab"; id: string }
  | { kind: "macTabs" }
  | { kind: "inbox" };

export type TabKind = "open" | "private" | "archived";

export type LinkState = { onboarding: boolean; syncEnabled: boolean; canSearchByVoice: boolean; sharesAsShare: boolean; tabKind: (id: string) => TabKind | null };

export type LinkAction =
  | { kind: "hold" }
  | { kind: "openUrl"; url: string; origin: "link" | "share" }
  | { kind: "searchNow"; query: string }
  | { kind: "tray"; query: string; incognito: boolean }
  | { kind: "voice" }
  | { kind: "switchTab"; id: string }
  | { kind: "restoreTab"; id: string }
  | { kind: "spaces" }
  | { kind: "syncSettings" }
  | { kind: "inbox" }
  | { kind: "none" };

const WEB = /^https?:\/\//i;

export function linkAction(link: IncomingLink, state: LinkState): LinkAction {
  if (state.onboarding && link.kind !== "inbox") return { kind: "hold" };
  switch (link.kind) {
    case "open":
      if (!WEB.test(link.url.trim())) return { kind: "none" };
      return { kind: "openUrl", url: link.url.trim(), origin: state.sharesAsShare && link.source === "share" ? "share" : "link" };
    case "search": {
      const query = link.query?.trim() ?? "";
      return query ? { kind: "searchNow", query } : { kind: "tray", query: "", incognito: false };
    }
    case "voiceSearch":
      return state.canSearchByVoice ? { kind: "voice" } : { kind: "tray", query: "", incognito: false };
    case "incognito":
      return { kind: "tray", query: "", incognito: true };
    case "tab":
      switch (state.tabKind(link.id)) {
        case "open":
          return { kind: "switchTab", id: link.id };
        case "archived":
          return { kind: "restoreTab", id: link.id };
        default:
          return { kind: "none" };
      }
    case "macTabs":
      return state.syncEnabled ? { kind: "spaces" } : { kind: "syncSettings" };
    case "inbox":
      return { kind: "inbox" };
  }
}

export type Cover = "tray" | "voice" | "sheet" | "settings" | "pageMenu" | "reader" | "find";

export const ALL_COVERS: readonly Cover[] = ["tray", "voice", "sheet", "settings", "pageMenu", "reader", "find"];

export function coversToClose(action: LinkAction): readonly Cover[] {
  switch (action.kind) {
    case "hold":
    case "none":
    case "inbox":
      return [];
    case "tray":
      return ALL_COVERS.filter((cover) => cover !== "tray");
    case "voice":
      return ALL_COVERS.filter((cover) => cover !== "voice" && cover !== "tray");
    default:
      return ALL_COVERS;
  }
}

export function heldAfterOnboarding(held: readonly IncomingLink[]): IncomingLink[] {
  const last = held.filter((link) => link.kind !== "inbox").at(-1);
  return last ? [last] : [];
}

export const opensLaunchTray = (autoOpensKeyboard: boolean, held: readonly IncomingLink[]) => autoOpensKeyboard && heldAfterOnboarding(held).length === 0;

export const KEPT_LINKS_LIMIT = 10;

const isText = (value: unknown): value is string => typeof value === "string";

function keptLink(value: unknown): IncomingLink | null {
  if (typeof value !== "object" || value === null) return null;
  const link = value as Record<string, unknown>;
  const source = isText(link.source) ? { source: link.source } : {};
  switch (link.kind) {
    case "open":
      return isText(link.url) ? { kind: "open", url: link.url, ...source } : null;
    case "search":
      return link.query === null || isText(link.query) ? ({ kind: "search", query: link.query, ...source } as IncomingLink) : null;
    case "tab":
      return isText(link.id) ? ({ kind: "tab", id: link.id, ...source } as IncomingLink) : null;
    case "voiceSearch":
    case "incognito":
    case "macTabs":
    case "inbox":
      return { kind: link.kind, ...source } as IncomingLink;
    default:
      return null;
  }
}

export const keptLinks = (links: readonly IncomingLink[]) => JSON.stringify(links.slice(-KEPT_LINKS_LIMIT));

export function restoredLinks(raw: string | undefined): IncomingLink[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => keptLink(value) ?? []).slice(-KEPT_LINKS_LIMIT);
}
