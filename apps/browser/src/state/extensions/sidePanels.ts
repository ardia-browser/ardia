import { extensionSidePanelUrl } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { shownPageId } from "../peek/peek";
import { noteSidePanelKept } from "../telemetry/usage";
import { shownReadyTab, extensionPageUrl, extensionProfile, isPrivate, pageProfile, shownIn, tabProfile, useExtensions, type SidePanel, type SidePanelCard } from "./store";

const wanted = new Map<string, string>();
const fetches = new Map<string, number>();
const rechecks = new Map<string, number>();
const answered = new Map<string, Map<string, { asked: number; url: string | null }>>();
let lookups = 0;

async function askPanel(windowId: string, tabId: string, extensionId: string): Promise<{ url: string | null; stale: boolean; newest: string | null }> {
  const asked = ++lookups;
  const url = await extensionSidePanelUrl(tabId, extensionId, tabProfile(tabId));
  const key = `${extensionId}|${tabId}`;
  let seen = answered.get(windowId);
  if (!seen) answered.set(windowId, (seen = new Map()));
  const newer = seen.get(key);
  if (newer && newer.asked > asked) return { url, stale: true, newest: newer.url };
  seen.set(key, { asked, url });
  return { url, stale: false, newest: url };
}
const openings = new Map<string, number>();
const focusOwed = new Map<string, { opened: number; page: string | undefined }>();
let lastOpening = 0;
const shownTabs = new Map<string, Set<string>>();
const closedTabs = new Map<string, Set<string>>();
const removedTabs = new Map<string, Set<string>>();

const tabsOf = (tabs: Map<string, Set<string>>, windowId: string) => {
  let set = tabs.get(windowId);
  if (!set) tabs.set(windowId, (set = new Set()));
  return set;
};

const nextFetch = (windowId: string) => {
  const ticket = (fetches.get(windowId) ?? 0) + 1;
  fetches.set(windowId, ticket);
  return ticket;
};

export const wantedSidePanels = () => [...wanted];

export const panelTabOpen = (windowId: string, tabId?: string) => !tabId || useBrowser.getState().tabs[tabId]?.windowId === windowId;

export const panelClosedOnTab = (windowId: string, tabId?: string) => !!tabId && !!closedTabs.get(windowId)?.has(tabId);

export const panelDroppedOnTab = (windowId: string, tabId?: string) => panelClosedOnTab(windowId, tabId) || (!!tabId && !!removedTabs.get(windowId)?.has(tabId));

const sameCard = (a: SidePanel, b: SidePanel) => a.extensionId === b.extensionId && a.pageProfile === b.pageProfile && a.url === b.url && a.opened === b.opened;

export function takeSidePanelFocus(windowId: string, panel: SidePanel): boolean {
  const owed = focusOwed.get(windowId);
  const { sidePanels, sidePanelLookups } = useExtensions.getState();
  const now = sidePanels[windowId];
  if (owed?.opened !== panel.opened || sidePanelLookups[windowId] || !now || !sameCard(now, panel)) return false;
  focusOwed.delete(windowId);
  return owed.page === shownPageId(useBrowser.getState(), windowId);
}

function countLookup(windowId: string, by: number) {
  useExtensions.setState((e) => {
    const sidePanelLookups = { ...e.sidePanelLookups };
    const left = (sidePanelLookups[windowId] ?? 0) + by;
    if (left > 0) sidePanelLookups[windowId] = left;
    else delete sidePanelLookups[windowId];
    return { sidePanelLookups };
  });
}

export function openSidePanel(windowId: string, extensionId: string): Promise<void> {
  if (!shownIn(windowId, extensionId)) return Promise.resolve();
  const reopening = wanted.get(windowId) !== extensionId;
  if (reopening) {
    shownTabs.delete(windowId);
    closedTabs.delete(windowId);
    removedTabs.delete(windowId);
  }
  if (reopening || useExtensions.getState().sidePanels[windowId]?.hidden) {
    lastOpening += 1;
    openings.set(windowId, lastOpening);
    focusOwed.set(windowId, { opened: lastOpening, page: shownPageId(useBrowser.getState(), windowId) });
  }
  wanted.set(windowId, extensionId);
  const tab = shownPageId(useBrowser.getState(), windowId);
  if (tab) closedTabs.get(windowId)?.delete(tab);
  refreshSidePanelCards(windowId);
  return syncSidePanel(windowId);
}

export function closeSidePanel(windowId: string, extensionId?: string) {
  const id = wanted.get(windowId);
  if (!id || (extensionId && id !== extensionId)) return;
  wanted.delete(windowId);
  shownTabs.delete(windowId);
  closedTabs.delete(windowId);
  removedTabs.delete(windowId);
  openings.delete(windowId);
  focusOwed.delete(windowId);
  answered.delete(windowId);
  nextFetch(windowId);
  if (useExtensions.getState().sidePanels[windowId])
    useExtensions.setState((e) => {
      const sidePanels = { ...e.sidePanels };
      delete sidePanels[windowId];
      return { sidePanels };
    });
  refreshSidePanelCards(windowId);
}

function hideSidePanel(windowId: string) {
  const now = useExtensions.getState().sidePanels[windowId];
  if (!now) return closeSidePanel(windowId);
  if (!now.hidden) useExtensions.setState((e) => ({ sidePanels: { ...e.sidePanels, [windowId]: { ...now, hidden: true } } }));
  refreshSidePanelCards(windowId);
}

export function closeSidePanelOnTab(windowId: string, ownerTabId?: string): boolean {
  const shownTab = shownPageId(useBrowser.getState(), windowId) ?? useExtensions.getState().sidePanels[windowId]?.tabId;
  const tabId = ownerTabId ?? shownTab;
  if (!tabId) {
    closeSidePanel(windowId);
    return true;
  }
  shownTabs.get(windowId)?.delete(tabId);
  tabsOf(closedTabs, windowId).add(tabId);
  if (tabId !== shownTab) {
    const entry = useExtensions.getState().sidePanels[windowId];
    if (entry && !entry.hidden && entry.tabId === tabId) {
      hideSidePanel(windowId);
      return false;
    }
    refreshSidePanelCards(windowId);
    return false;
  }
  const others = [...(shownTabs.get(windowId) ?? [])].some((id) => panelTabOpen(windowId, id));
  if (!others) closeSidePanel(windowId);
  else {
    nextFetch(windowId);
    hideSidePanel(windowId);
  }
  return true;
}

export function toggleSidePanel(windowId: string, extensionId: string): Promise<void> | void {
  const shown = useExtensions.getState().sidePanels[windowId];
  if (wanted.get(windowId) === extensionId && !shown?.hidden) closeSidePanelOnTab(windowId);
  else return openSidePanel(windowId, extensionId);
}

export function closeSidePanelsOf(extensionId: string) {
  for (const [windowId, id] of wanted) if (id === extensionId) closeSidePanel(windowId);
}

export async function syncSidePanel(windowId: string): Promise<void> {
  const extensionId = wanted.get(windowId);
  if (!extensionId) return;
  if (focusOwed.get(windowId)?.page !== shownPageId(useBrowser.getState(), windowId)) focusOwed.delete(windowId);
  countLookup(windowId, 1);
  try {
    await showSidePanel(windowId, extensionId);
  } finally {
    countLookup(windowId, -1);
  }
}

async function showSidePanel(windowId: string, extensionId: string): Promise<void> {
  const ticket = nextFetch(windowId);
  const readyTab = shownReadyTab(windowId);
  const shown = useExtensions.getState().sidePanels[windowId];
  if (!readyTab && shown?.extensionId === extensionId) return;
  if (panelClosedOnTab(windowId, readyTab)) return hideSidePanel(windowId);
  const ext = shownIn(windowId, extensionId);
  const url = !ext
    ? null
    : readyTab
      ? (await askPanel(windowId, readyTab, extensionId)).newest
      : !isPrivate(useBrowser.getState(), windowId) && ext.sidePanel
        ? extensionPageUrl(extensionId, ext.sidePanel)
        : null;
  if (fetches.get(windowId) !== ticket) return;
  if (!shownIn(windowId, extensionId)) return closeSidePanel(windowId);
  placePanel(windowId, extensionId, readyTab, url);
}

function placePanel(windowId: string, extensionId: string, readyTab: string | undefined, url: string | null) {
  if (!url && readyTab && shownTabs.get(windowId)?.delete(readyTab)) tabsOf(removedTabs, windowId).add(readyTab);
  if (!url) return readyTab ? hideSidePanel(windowId) : closeSidePanel(windowId);
  const s = useBrowser.getState();
  const panel = { extensionId, profile: extensionProfile(s, windowId), pageProfile: pageProfile(s, windowId), url, opened: openings.get(windowId) ?? 0, tabId: readyTab };
  if (readyTab) {
    const pageKept = sidePanelCards(windowId).some((card) => panelKey(card) === panelKey(panel) && card.owners.includes(readyTab));
    if (pageKept && useExtensions.getState().sidePanels[windowId]?.tabId !== readyTab) noteSidePanelKept();
    tabsOf(shownTabs, windowId).add(readyTab);
    removedTabs.get(windowId)?.delete(readyTab);
  }
  const now = useExtensions.getState().sidePanels[windowId];
  if (now && now.extensionId === panel.extensionId && now.url === url && now.profile === panel.profile && now.pageProfile === panel.pageProfile && now.opened === panel.opened && now.tabId === panel.tabId && !now.hidden) return;
  useExtensions.setState((e) => ({ sidePanels: { ...e.sidePanels, [windowId]: panel } }));
  refreshSidePanelCards(windowId);
}

export const panelKey = (p: SidePanel) => `${p.extensionId}|${p.pageProfile}|${p.url}`;

const NO_CARDS: SidePanelCard[] = [];

const ownerKept = (windowId: string, extensionId: string, tabId: string) =>
  wanted.get(windowId) === extensionId && panelTabOpen(windowId, tabId) && !panelDroppedOnTab(windowId, tabId);

function keptCard(windowId: string, card: SidePanelCard, visible: SidePanel | undefined): SidePanelCard | null {
  const owners = card.owners.filter((tab) => ownerKept(windowId, card.extensionId, tab) && !(visible && tab === visible.tabId && panelKey(visible) !== panelKey(card)));
  if (!owners.length && !(visible && panelKey(visible) === panelKey(card))) return null;
  return owners.length === card.owners.length ? card : { ...card, owners };
}

function withVisible(card: SidePanelCard | undefined, visible: SidePanel): SidePanelCard {
  const owners = card ? card.owners : [];
  const all = visible.tabId && !owners.includes(visible.tabId) ? [...owners, visible.tabId] : owners;
  const same = card && card.tabId === visible.tabId && card.opened === visible.opened && card.profile === visible.profile && all === owners;
  return same ? card! : { ...visible, owners: all };
}

function setCards(windowId: string, cards: SidePanelCard[]) {
  useExtensions.setState((e) => {
    const sidePanelCards = { ...e.sidePanelCards };
    if (cards.length) sidePanelCards[windowId] = cards;
    else delete sidePanelCards[windowId];
    return { sidePanelCards };
  });
}

export const sidePanelCards = (windowId: string) => useExtensions.getState().sidePanelCards[windowId] ?? NO_CARDS;

export function refreshSidePanelCards(windowId: string) {
  const shown = useExtensions.getState().sidePanels[windowId];
  const visible = shown && !shown.hidden ? shown : undefined;
  const before = sidePanelCards(windowId);
  let next = before.flatMap((card) => keptCard(windowId, card, visible) ?? []);
  if (visible) {
    const at = next.findIndex((card) => panelKey(card) === panelKey(visible));
    next = at < 0 ? [...next, withVisible(undefined, visible)] : next.map((card, i) => (i === at ? withVisible(card, visible) : card));
  }
  if (next.length !== before.length || next.some((card, i) => card !== before[i])) setCards(windowId, next);
}

export function settleSidePanelTabs(windowId: string) {
  const entry = useExtensions.getState().sidePanels[windowId];
  if (entry && !entry.hidden && entry.tabId && !panelTabOpen(windowId, entry.tabId)) return hideSidePanel(windowId);
  refreshSidePanelCards(windowId);
}

export function watchSidePanelCards(): () => void {
  return useBrowser.subscribeTo(["tabs", "windows"], (s, prev) => {
    if (s.tabs === prev.tabs && s.windows === prev.windows) return;
    const { sidePanels, sidePanelCards: cards } = useExtensions.getState();
    for (const windowId of new Set([...Object.keys(cards), ...Object.keys(sidePanels)])) settleSidePanelTabs(windowId);
  });
}

const listedCard = (windowId: string, card: SidePanel) => sidePanelCards(windowId).find((c) => panelKey(c) === panelKey(card));

export function closePanelCard(windowId: string, card: SidePanel) {
  const live = listedCard(windowId, card);
  if (!live) return;
  const entry = useExtensions.getState().sidePanels[windowId];
  if (wanted.get(windowId) !== card.extensionId) {
    if (entry && !entry.hidden && panelKey(entry) === panelKey(card)) hideSidePanel(windowId);
    return dropSidePanelCard(windowId, live);
  }
  if (!live.owners.length) return closeSidePanel(windowId, card.extensionId);
  const shownLast = [...live.owners].sort((x, y) => Number(x === entry?.tabId) - Number(y === entry?.tabId));
  for (const tabId of shownLast) closeSidePanelOnTab(windowId, tabId);
  dropSidePanelCard(windowId, live);
}

function dropOwner(windowId: string, card: SidePanelCard, tabId: string) {
  const owners = card.owners.filter((tab) => tab !== tabId);
  const cards = sidePanelCards(windowId);
  setCards(windowId, owners.length ? cards.map((c) => (c === card ? { ...card, owners } : c)) : cards.filter((c) => c !== card));
}

export async function recheckKeptSidePanels(windowId: string): Promise<void> {
  const generation = (rechecks.get(windowId) ?? 0) + 1;
  rechecks.set(windowId, generation);
  const extensionId = wanted.get(windowId);
  const asks = sidePanelCards(windowId)
    .filter((card) => card.extensionId === extensionId)
    .flatMap((card) => card.owners.map((tabId) => ({ card, tabId })));
  await Promise.all(
    asks.map(async ({ card, tabId }) => {
      const { url, stale } = await askPanel(windowId, tabId, card.extensionId).catch(() => ({ url: card.url, stale: true, newest: card.url }));
      const live = sidePanelCards(windowId).find((c) => c.extensionId === card.extensionId && c.owners.includes(tabId));
      if (stale || rechecks.get(windowId) !== generation || wanted.get(windowId) !== card.extensionId || !live?.owners.includes(tabId)) return;
      if (url === live.url) return;
      const entry = useExtensions.getState().sidePanels[windowId];
      const onScreen = !!entry && !entry.hidden && entry.tabId === tabId && panelKey(entry) === panelKey(live);
      if (url) return onScreen ? placePanel(windowId, card.extensionId, tabId, url) : dropOwner(windowId, live, tabId);
      shownTabs.get(windowId)?.delete(tabId);
      tabsOf(removedTabs, windowId).add(tabId);
      if (onScreen) hideSidePanel(windowId);
      else refreshSidePanelCards(windowId);
    }),
  );
}

export function dropSidePanelCard(windowId: string, card: SidePanel) {
  const before = sidePanelCards(windowId);
  const after = before.filter((c) => panelKey(c) !== panelKey(card));
  if (after.length !== before.length) setCards(windowId, after);
}
