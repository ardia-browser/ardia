import type { CommandAction } from "@ardia/core";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTab, isIncognitoProfile, viewTabIds } from "../browser/model";
import { hiddenEmptyCard } from "../omnibox/newTabBarPolicy";
import { isStacked, MAX_SPLIT_PANES, splitOf, splitTabIds, splitTabIdsOf, splitViewAvailable } from "../splits/splits";
import type { SplitView, Tab } from "../browser/types";
import { t } from "../../lib/uiLanguage";


export type OrganizeContext = { s: BrowserState; windowId: string; tab: Tab; split: SplitView | undefined };

type OrganizeDef<Id extends string = string> = {
  id: Id;
  title: string | ((c: OrganizeContext) => string);
  icon: string;
  keywords: string[];
  shows(c: OrganizeContext): boolean;
};

export const sideBySide = (split: SplitView | undefined) => split?.orientation === "horizontal";
const hasRoom = (split: SplitView | undefined) => !split || splitTabIds(split).length < MAX_SPLIT_PANES;
const stacked = ({ split, tab }: OrganizeContext) => !!split && isStacked(split, tab.id);
const inProfiles = ({ s, windowId, tab }: OrganizeContext) => s.windows[windowId]?.kind !== "private" && !isIncognitoProfile(tab.profileId);

export function splitCandidates({ s, windowId, tab, split }: OrganizeContext): Tab[] {
  return viewTabIds(s, windowId)
    .map((id) => s.tabs[id]!)
    .filter((t) => t.id !== tab.id && !!t.url && !splitTabIdsOf(split)?.includes(t.id));
}

const organizeDefs = <const Id extends string>(defs: OrganizeDef<Id>[]) => defs;

const DEFS = organizeDefs([
  {
    id: "split:sideBySide",
    title: t(`Split View Side by Side`),
    icon: "rectangle.split.2x1",
    keywords: [t(`split view`), t(`side by side`), t(`new split`), t(`vertical split`)],
    shows: (c) => !c.split,
  },
  {
    id: "split:stacked",
    title: t(`Split View Stacked`),
    icon: "rectangle.split.1x2",
    keywords: [t(`split view`), "stacked", t(`top and bottom`), t(`horizontal split`)],
    shows: (c) => !c.split,
  },
  {
    id: "split:withTab",
    title: ({ split }) => (split ? t(`Add Tab to Split View…`) : t(`Split View with Tab…`)),
    icon: "plus.rectangle.on.rectangle",
    keywords: [t(`split view`), t(`add tab to split`), t(`split with tab`), t(`add pane`)],
    shows: (c) => hasRoom(c.split) && splitCandidates(c).length > 0,
  },
  {
    id: "split:add",
    title: ({ split }) => (sideBySide(split) ? t(`Add Vertical Split View`) : t(`Add Horizontal Split View`)),
    icon: "rectangle.split.3x1",
    keywords: [t(`split view`), t(`add pane`), t(`new pane`)],
    shows: (c) => !!c.split && hasRoom(c.split),
  },
  {
    id: "split:cross",
    title: ({ split }) => (sideBySide(split) ? t(`Add Bottom Split`) : t(`Add Right Split`)),
    icon: "rectangle.bottomhalf.inset.filled",
    keywords: [t(`split view`), t(`add pane`), "stacked", t(`side by side`)],
    shows: (c) => !!c.split && hasRoom(c.split) && !stacked(c),
  },
  {
    id: "split:flip",
    title: t(`Flip Split View`),
    icon: "arrow.left.arrow.right",
    keywords: [t(`split view`), t(`swap panes`)],
    shows: (c) => !!c.split,
  },
  {
    id: "split:convert",
    title: ({ split }) => (sideBySide(split) ? t(`Convert to Vertical Split View`) : t(`Convert to Horizontal Split View`)),
    icon: "rectangle.split.1x2",
    keywords: [t(`split view`), t(`rotate split`), "stacked", t(`side by side`)],
    shows: (c) => !!c.split,
  },
  {
    id: "split:remove",
    title: t(`Remove from Split View`),
    icon: "rectangle.portrait.and.arrow.right",
    keywords: [t(`split view`), t(`remove pane`), t(`unsplit tab`)],
    shows: (c) => !!c.split,
  },
  {
    id: "split:exit",
    title: t(`Exit Split View`),
    icon: "rectangle.split.3x1",
    keywords: [t(`split view`), t(`separate all tabs`), "unsplit", t(`close split view`), t(`end split`)],
    shows: (c) => !!c.split,
  },
  {
    id: "profile:moveTab",
    title: t(`Move Tab to Profile…`),
    icon: "person.crop.circle",
    keywords: [t(`move tab`), t(`move to profile`), t(`move to space`), t(`send tab to profile`)],
    shows: inProfiles,
  },
  {
    id: "profile:rename",
    title: t(`Rename Profile…`),
    icon: "pencil",
    keywords: [t(`rename profile`), t(`rename space`), t(`profile name`)],
    shows: inProfiles,
  },
  {
    id: "profile:edit",
    title: t(`Edit Profiles…`),
    icon: "person.2",
    keywords: [t(`manage profiles`), t(`reorder profiles`), t(`delete profile`), "spaces", t(`profile settings`)],
    shows: inProfiles,
  },
]);

export type OrganizeId = (typeof DEFS)[number]["id"];

const BY_ID = new Map<string, OrganizeDef>(DEFS.map((d) => [d.id, d]));

export const isOrganizeId = (id: string): id is OrganizeId => BY_ID.has(id);

function contextFor(s: BrowserState, windowId: string): OrganizeContext | null {
  const w = s.windows[windowId];
  const tab = activeTab(s, windowId);
  if (!w || w.kind === "small" || !tab || hiddenEmptyCard(s, tab)) return null;
  return { s, windowId, tab, split: splitOf(s, tab.id) };
}

export function organizeActions(s: BrowserState, windowId: string): CommandAction[] {
  const c = contextFor(s, windowId);
  if (!c) return [];
  const out: CommandAction[] = DEFS.filter((d) => (splitViewAvailable || !d.id.startsWith("split:")) && d.shows(c)).map((d) => ({
    id: d.id,
    title: typeof d.title === "string" ? d.title : d.title(c),
    icon: d.icon,
    keywords: d.keywords,
  }));
  if (inProfiles(c)) {
    for (const id of s.profileOrder) {
      if (id === c.tab.profileId) continue;
      const name = s.profiles[id]?.name ?? "";
      out.push({ id: `moveTabToProfile:${id}`, title: `Move Tab to ${name}`, icon: "arrow.right.circle", keywords: [name, t(`move tab`), t(`move to profile`), t(`move to space`)] });
    }
    out.push({ id: "moveTabToProfile:new", title: t(`Move Tab to New Profile`), icon: "person.crop.circle.badge.plus", keywords: [t(`move tab`), t(`new profile`), t(`new space`)] });
  }
  return out;
}

export function shownOrganizeContext(id: OrganizeId, windowId: string): OrganizeContext | null {
  const c = contextFor(useBrowser.getState(), windowId);
  return c && BY_ID.get(id)?.shows(c) ? c : null;
}
