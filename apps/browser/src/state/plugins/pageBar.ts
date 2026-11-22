import { switchOrigin, type PageBarSpec } from "../../lib/pluginPageBar";
import { confirmedDocument, type PageDocument } from "./pageBarDocuments";
import { siteSwitchValue, pluginOrder } from "./siteSwitches";
import { activeManifest, type PluginsStore } from "./store";

export type PageBarPane = {
  tabId: string;
  visible: boolean;
  lingering: boolean;
  warm: boolean;
  covered: boolean;
  mounted: boolean;
  live: boolean;
  frozen: boolean;
  newTabShown: boolean;
  peek: boolean;
  otherProfile: boolean;
  privatePage: boolean;
  small: boolean;
  documentFullscreen: boolean;
  windowFullscreen: boolean;
};

export type PageBarMatch = { plugin: string; official: boolean; spec: PageBarSpec; url: string; at: number; superseded: number };

export type PageBarState = { plugins: Pick<PluginsStore, "listings" | "records" | "order">; documents: Record<string, PageDocument> };

export function pageBarPaneEligible(p: PageBarPane): boolean {
  if (!p.visible || p.lingering || p.warm || p.covered || !p.mounted || !p.live || p.frozen || p.newTabShown) return false;
  if (p.peek || p.otherProfile || p.privatePage || p.small) return false;
  return !p.documentFullscreen && !p.windowFullscreen;
}

export function pageBarFor(state: PageBarState, pane: PageBarPane): PageBarMatch | null {
  if (!pageBarPaneEligible(pane)) return null;
  const doc = confirmedDocument(state.documents, pane.tabId);
  const origin = doc ? switchOrigin(doc.url) : null;
  if (!doc || !origin) return null;
  const matches = pluginOrder(state.plugins).flatMap((plugin) => {
    const manifest = activeManifest(state.plugins, plugin)!;
    const spec = manifest.contributes.pageBar;
    if (!spec?.when.siteSwitch || siteSwitchValue(state.plugins, plugin, spec.when.siteSwitch, origin) !== true) return [];
    return [{ plugin, official: !!state.plugins.listings[plugin]?.official && manifest.official, spec }];
  });
  const first = matches[0];
  return first ? { ...first, url: doc.url, at: doc.at, superseded: matches.length - 1 } : null;
}

export const sameMatch = (a: PageBarMatch | null | undefined, b: PageBarMatch | null | undefined): boolean =>
  a === b || (!!a && !!b && a.plugin === b.plugin && a.spec === b.spec && a.url === b.url && a.at === b.at && a.superseded === b.superseded);
