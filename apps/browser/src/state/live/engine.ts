import { onWindowEvent } from "../../platform/windows";
import { everySlowly } from "../../platform/slowTimers";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, inPinnedContainer, viewTabIds } from "../browser/model";
import { awayFromPin } from "../pins/organize";
import { pinnedGroupMembers } from "../browser/structure";
import { shownTabIds } from "../tabs/shownTabs";
import { repoKey } from "./rows";
import { hideNewRepos } from "./repoFilter";
import { SOURCES } from "./sources";
import { beginLiveRefresh, applyFetch, createFolder, finishCompleting, live, markRead, removeFolder, setStatus, unhide, updateFolder, useLive } from "./store";
import { LiveError, type CompletionState, type LiveFolder, type LiveFolderKind, type LiveItem, type LiveSourceId, type PullRequestSection } from "./types";
import { noteLiveCompletedTabsClosed } from "../telemetry/liveCompletedTabs";
import { noteLiveSourceFetch } from "../telemetry/workCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { isPlaying, useMedia } from "../media/media";
import { usePages } from "../tabs/pageState";
import { liveOf, onLiveChange } from "../tabs/tabLive";
import { capturing, whenCaptureEndsUnderHiddenCompleted } from "./captureEnds";
import { during } from "../app/jobActivity";

const INTERVAL_MS: Record<LiveFolderKind, number> = { pullRequests: 3 * 60_000, documents: 10 * 60_000 };
const STALE_ON_FOCUS_MS = 60_000;
export const COMPLETION_MS = 2600;

const inflight = new Map<string, Promise<void>>();
const fetchingWith = new Map<string, string>();
const followUps = new Map<string, () => boolean>();
const passGuards = new Map<string, () => boolean>();
const always = () => true;
const settingsOf = (folder: LiveFolder | undefined) => (folder ? JSON.stringify([folder.sources, folder.filters], sortedKeys) : "");
const fetchedSources = new Map<string, Set<LiveSourceId>>();
const sharedFetches = new Map<string, Promise<LiveItem[]>>();

function fetchSource(source: LiveSourceId, folder: LiveFolder, interactive: boolean, consent?: ConsentToken | null): Promise<LiveItem[]> {
  const key = JSON.stringify([source, live().accounts[source]?.connectedAt ?? null, folder.filters]);
  const running = sharedFetches.get(key);
  noteLiveSourceFetch(!!running, consent);
  if (running) return running;
  const task = SOURCES[source].fetch(folder, { interactive, consent }).finally(() => sharedFetches.delete(key));
  sharedFetches.set(key, task);
  return task;
}

const SECTION_ORDER: Record<PullRequestSection, number> = { authored: 0, review: 1, team: 2 };

function order(items: LiveItem[]): LiveItem[] {
  return [...items].sort(
    (a, b) => (SECTION_ORDER[a.section ?? "authored"] ?? 0) - (SECTION_ORDER[b.section ?? "authored"] ?? 0) || b.updatedAt - a.updatedAt,
  );
}

function queueFollowUp(folderId: string, allowed: () => boolean) {
  const earlier = followUps.get(folderId);
  followUps.set(folderId, earlier && earlier !== allowed ? () => earlier() || allowed() : allowed);
}

export function refreshFolder(folderId: string, interactive = false, consent?: ConsentToken | null): Promise<void> {
  return refreshFolderWhile(folderId, interactive, always, consent);
}

export function refreshFolderWhile(folderId: string, interactive: boolean, allowed: () => boolean, given?: ConsentToken | null): Promise<void> {
  const consent = given === undefined ? consentToken() : given;
  const running = inflight.get(folderId);
  if (running) {
    if (passGuards.get(folderId) !== allowed) return running.catch(() => undefined).then(() => (allowed() ? refreshFolderWhile(folderId, interactive, allowed, consent) : undefined));
    if (fetchingWith.has(folderId) && settingsOf(live().folders[folderId]) !== fetchingWith.get(folderId)) queueFollowUp(folderId, allowed);
    return running;
  }
  passGuards.set(folderId, allowed);
  const task = during("liveFolders", () => runUntilCurrent(folderId, interactive, allowed, consent)).finally(() => [inflight, fetchingWith, followUps, passGuards].forEach((m) => m.delete(folderId)));
  inflight.set(folderId, task);
  return task;
}

async function runUntilCurrent(folderId: string, interactive: boolean, allowed: () => boolean, consent: ConsentToken | null) {
  for (let guard: (() => boolean) | undefined = allowed; guard && live().folders[folderId]; ) {
    passGuards.set(folderId, guard);
    await run(folderId, interactive, guard, consent);
    fetchingWith.delete(folderId);
    guard = followUps.get(folderId);
    followUps.delete(folderId);
  }
}

export function manualRefresh(folderId: string, allowed: () => boolean = always): Promise<void> {
  unhide(folderId);
  return refreshFolderWhile(folderId, true, allowed);
}

const sortedKeys = (_key: string, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value;
const sameFolder = (a: unknown, b: unknown) => JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys);

function claimRefresh(folderId: string) {
  const refresh = beginLiveRefresh(folderId);
  const consent = consentToken();
  return refresh?.catch((error: unknown) => { warnFor(consent, "Couldn't claim the live folder refresh", error); return null; }).then((fence) => {
    if (fence === null && live().folders[folderId]) setStatus(folderId, { state: "idle" });
    return fence;
  });
}

function staleRun(folderId: string, folder: LiveFolder, allowed: () => boolean): boolean {
  if (!allowed()) return (setStatus(folderId, { state: "idle" }), true);
  if (settingsOf(live().folders[folderId]) === settingsOf(folder)) return false;
  queueFollowUp(folderId, allowed);
  return true;
}

async function run(folderId: string, interactive: boolean, allowed: () => boolean, consent: ConsentToken | null) {
  if (!live().folders[folderId] || !allowed()) return;
  const claim = claimRefresh(folderId);
  let fence = claim ? await claim : undefined;
  if (fence === null) return;
  const folder = live().folders[folderId];
  if (!folder) return;
  if (!allowed()) return setStatus(folderId, { state: "idle" });
  fetchingWith.set(folderId, settingsOf(folder));
  const before = live();
  setStatus(folderId, { state: before.status[folderId]?.lastFetch ? "updating" : "initializing" });
  const results = await Promise.allSettled(folder.sources.map((id) => fetchSource(id, folder, interactive, consent)));

  const fetched: LiveItem[] = [];
  const failed: { source: LiveSourceId; error: unknown }[] = [];
  results.forEach((r, i) => {
    const source = folder.sources[i]!;
    if (r.status === "fulfilled") fetched.push(...r.value);
    else failed.push({ source, error: r.reason });
  });
  if (!live().folders[folderId] || staleRun(folderId, folder, allowed)) return;
  const fromFailedSource = (it: LiveItem) => failed.some((f) => f.source === it.source);
  const listedByFilters = (it: LiveItem) => (it.section === "review" || it.section === "team" ? folder.filters.reviewRequests : folder.filters.authored);
  const repoShown = (it: LiveItem) => {
    const repo = repoKey(it);
    return !repo || !live().folders[folderId]?.hiddenRepos.includes(repo);
  };
  const fetchWouldList = (it: LiveItem) => folder.sources.includes(it.source) && !fromFailedSource(it) && listedByFilters(it) && repoShown(it);

  const landed = live();
  const ids = new Set(fetched.map((it) => it.id));
  const animatingAtLanding = new Set(landed.completing[folderId] ?? []);
  const missing = [...(landed.items[folderId] ?? []), ...(landed.hidden[folderId] ?? [])].filter((it) => !ids.has(it.id) && !animatingAtLanding.has(it.id) && fetchWouldList(it));
  const gone: Record<string, CompletionState> = {};
  for (const source of new Set(missing.map((it) => it.source))) {
    const resolve = SOURCES[source].resolveGone;
    if (!resolve) continue;
    Object.assign(gone, await resolve(missing.filter((it) => it.source === source), { interactive, consent }).catch(() => ({})));
  }

  if (!live().folders[folderId] || staleRun(folderId, folder, allowed)) return;
  const folderBeforeHiding = live().folders[folderId];
  hideNewRepos(folderId, fetched);
  const folderAfterHiding = live().folders[folderId];
  if (fence !== undefined && allowed() && sameFolder(folderBeforeHiding, folder) && !sameFolder(folderAfterHiding, folderBeforeHiding)) {
    const reclaim = claimRefresh(folderId);
    fence = reclaim ? await reclaim : undefined;
    if (fence === null || !live().folders[folderId]) return;
    if (!sameFolder(live().folders[folderId], folderAfterHiding)) {
      setStatus(folderId, { state: "idle" });
      return;
    }
  }
  if (staleRun(folderId, folder, allowed)) return;
  const current = live();
  const prev = current.items[folderId] ?? [];
  const animating = new Set(current.completing[folderId] ?? []);
  const next = [...fetched.filter(repoShown), ...prev.filter((it) => fromFailedSource(it) && !animating.has(it.id))];

  const firstFailure = failed[0];
  if (firstFailure && failed.length === folder.sources.length && !prev.length && !before.status[folderId]?.lastFetch) {
    setStatus(folderId, { state: "error", error: describe(firstFailure.source, firstFailure.error) });
    return;
  }
  const lastSources = fetchedSources.get(folderId);
  const quiet = new Set(lastSources ? next.filter((it) => !lastSources.has(it.source)).map((it) => it.id) : []);
  const succeeded = new Set(folder.sources.filter((id) => !failed.some((f) => f.source === id)));
  fetchedSources.set(folderId, succeeded);
  applyFetch(folderId, order(next), gone, Date.now(), quiet, fence, succeeded);
  markCompletedTabs(folderId, gone, ids, consent);
  const warned = firstFailure ? null : folder.sources.map((source) => ({ source, error: SOURCES[source].warning?.() ?? null })).find((w) => w.error);
  const problem = firstFailure ?? warned;
  if (problem) setStatus(folderId, { state: "error", error: describe(problem.source, problem.error) });
  const leaving = Object.keys(gone);
  if (leaving.length) setTimeout(() => finishCompleting(folderId, leaving, fence), COMPLETION_MS);
}

function describe(source: LiveSourceId, error: unknown) {
  if (error instanceof LiveError) return { kind: error.kind, message: error.message, source };
  return { kind: "other" as const, message: String((error as Error)?.message ?? error), source };
}

export function statusText(folderId: string, now = Date.now()): string {
  const hidden = live().hidden[folderId]?.length ?? 0;
  return hidden ? `${fetchText(folderId, now)} · ${hidden} hidden until you refresh` : fetchText(folderId, now);
}

function fetchText(folderId: string, now: number): string {
  const st = live().status[folderId];
  if (!st || st.state === "initializing") return "Loading…";
  if (st.state === "updating") return "Updating…";
  if (st.error) return errorText(st.error.kind, st.error.source, now);
  if (!st.lastFetch) return "Not updated yet";
  const min = Math.floor((now - st.lastFetch) / 60_000);
  return min < 1 ? "Updated just now" : min < 60 ? `Updated ${min} min ago` : `Updated ${Math.floor(min / 60)} hr ago`;
}

export function errorText(kind: LiveError["kind"], source: LiveSourceId, now = Date.now()): string {
  const name = SOURCES[source].name;
  switch (kind) {
    case "notConfigured":
      return `Connect ${name} in Settings`;
    case "signedOut":
      return `Sign back in to ${name}`;
    case "sso":
      return `${name} needs Single Sign-On for this organization`;
    case "tokenBlocked":
      return `An organization's token policy hides its pull requests. Update your ${name} token.`;
    case "rateLimited": {
      const until = SOURCES[source].pausedUntil?.() ?? null;
      const minutes = until === null ? 0 : Math.ceil((until - now) / 60_000);
      if (minutes <= 0) return `${name} rate limit exceeded. Try again in a few minutes.`;
      return `${name} rate limit reached. Updating again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
    }
    case "network":
      return `Couldn't connect to ${name}`;
    default:
      return `We're having trouble connecting to ${name}`;
  }
}

export function newLiveFolder(windowId: string, kind: LiveFolderKind): string | null {
  const w = useBrowser.getState().windows[windowId];
  if (!w || w.kind === "private") return null;
  return newProfileLiveFolder(w.profileId, kind);
}

export const connectedSourcesOf = (kind: LiveFolderKind): LiveSourceId[] => {
  const s = live();
  return kind === "pullRequests" ? (["github", "bitbucket"] as const).filter((id) => s.accounts[id]) : (["notion", "confluence", "gdrive"] as const).filter((id) => s.accounts[id]);
};

export function newProfileLiveFolder(profileId: string, kind: LiveFolderKind, sources?: LiveSourceId[], options: { name?: string; allowed?: () => boolean } = {}): string {
  const connected = connectedSourcesOf(kind);
  const id = createFolder(profileId, kind, sources ?? (connected.length ? connected : undefined));
  if (options.name !== undefined) updateFolder(id, { name: options.name });
  void refreshFolderWhile(id, true, options.allowed ?? always);
  return id;
}

export function openLiveItem(windowId: string, folderId: string, item: LiveItem, options: { background?: boolean } = {}) {
  const s = useBrowser.getState();
  markRead(folderId, [item.id]);
  const existing = viewTabIds(s, windowId).find((id) => s.tabs[id]?.liveItem?.itemId === item.id && s.tabs[id]?.liveItem?.folderId === folderId);
  const home = folderItem(folderId, item.id)?.url ?? null;
  if (existing) {
    if (!inPinnedContainer(s, existing) && s.tabs[existing]!.pinnedUrl !== home) s.updateTab(existing, { pinnedUrl: home });
    if (!options.background) s.activate(existing);
    return existing;
  }
  const id = s.newTab(windowId, { url: item.url, background: options.background });
  const completed = live().completed[folderId]?.some((c) => c.item.id === item.id && ended(c.state));
  useBrowser.getState().updateTab(id, { liveItem: completed ? { folderId, itemId: item.id, completed } : { folderId, itemId: item.id }, pinnedUrl: home });
  return id;
}

function folderItem(folderId: string, itemId: string): LiveItem | undefined {
  const l = live();
  return (l.items[folderId] ?? []).find((i) => i.id === itemId) ?? (l.hidden[folderId] ?? []).find((i) => i.id === itemId) ?? l.completed[folderId]?.find((c) => c.item.id === itemId)?.item;
}

export function liveTabAway(tabId: string | null, s: BrowserState = useBrowser.getState()) {
  const tab = tabId ? s.tabs[tabId] : undefined;
  return !!tab && awayFromPin(tab);
}

export function returnLiveTab(tabId: string) {
  useBrowser.getState().returnToPinnedUrl(tabId);
}

export function deleteLiveFolder(folderId: string) {
  const s = useBrowser.getState();
  const tabs = Object.values(s.tabs).filter((t) => t.liveItem?.folderId === folderId).map((t) => t.id);
  if (tabs.length) s.closeTabs(tabs);
  removeFolder(folderId);
}

export function syncLiveHomes() {
  const s = useBrowser.getState();
  const members = pinnedGroupMembers(s.groups);
  for (const t of Object.values(s.tabs)) {
    if (!t.liveItem || t.pin || members.has(t.id) || !live().items[t.liveItem.folderId]) continue;
    const home = folderItem(t.liveItem.folderId, t.liveItem.itemId)?.url ?? null;
    if (home !== t.pinnedUrl) s.updateTab(t.id, { pinnedUrl: home });
  }
}

const ended = (state: CompletionState | undefined) => state === "merged" || state === "closed";

function markCompletedTabs(folderId: string, gone: Record<string, CompletionState>, listed: Set<string>, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const hidden = new Set((live().hidden[folderId] ?? []).map((it) => it.id));
  for (const t of Object.values(s.tabs)) {
    const ref = t.liveItem;
    if (ref?.folderId !== folderId) continue;
    if (ended(gone[ref.itemId]) && !hidden.has(ref.itemId) && !ref.completed) s.updateTab(t.id, { liveItem: { ...ref, completed: true } });
    else if (ref.completed && listed.has(ref.itemId)) s.updateTab(t.id, { liveItem: { folderId, itemId: ref.itemId } });
  }
  closeCompletedTabs(consent);
}

const inUse = (s: BrowserState, id: string) => {
  const media = useMedia.getState();
  return liveOf(id).playingAudio || !!media.pipOpen[id] || isPlaying(media.sessions[id]) || capturing(usePages.getState().pages[id]?.mediaAccess) || !!media.tabShares[id] || Object.values(media.tabShares).some((share) => share.capturedTabId === id);
};

function closeCompletedTabs(consent?: ConsentToken | null) {
  const s = useBrowser.getState();
  const { folders, items } = live();
  const shown = shownTabIds(s);
  const tabs = Object.values(s.tabs)
    .filter(({ id, liveItem: ref }) => ref?.completed && folders[ref.folderId]?.showCompleted === false && !shown.has(id) && !inPinnedContainer(s, id) && !inUse(s, id) && !items[ref.folderId]?.some((it) => it.id === ref.itemId))
    .map((t) => t.id);
  if (!tabs.length) return;
  s.closeTabs(tabs);
  noteLiveCompletedTabsClosed(tabs.length, consent);
}

let started = false;
const lastNudge = new Map<string, number>();

export function startLiveEngine() {
  if (started) return;
  started = true;

  const orphans = () => {
    const s = useBrowser.getState();
    const folders = live().folders;
    for (const t of Object.values(s.tabs)) if (t.liveItem && !folders[t.liveItem.folderId]) s.updateTab(t.id, { liveItem: undefined });
  };
  orphans();
  syncLiveHomes();
  useLive.subscribe((s, prev) => {
    if (s.folders !== prev.folders) orphans();
    if (s.items !== prev.items || s.hidden !== prev.hidden || s.completed !== prev.completed) syncLiveHomes();
    if (s.folders !== prev.folders || s.items !== prev.items) closeCompletedTabs();
  });
  closeCompletedTabs();

  useBrowser.subscribeTo(["groups", "profiles"], (s, prev) => {
    if (s.groups !== prev.groups) syncLiveHomes();
    if (s.profiles === prev.profiles) return;
    for (const f of Object.values(live().folders)) if (!s.profiles[f.profileId]) removeFolder(f.id);
  });

  const due = (id: string, maxAge: number) => {
    const f = live().folders[id];
    const st = live().status[id];
    return !!f && (!st?.lastFetch || Date.now() - st.lastFetch >= maxAge);
  };
  setTimeout(() => live().folderOrder.forEach((id) => void refreshFolder(id)), 2500);
  everySlowly({
    every: 30_000,
    run: () => {
      for (const id of live().folderOrder) if (due(id, INTERVAL_MS[live().folders[id]!.kind])) void refreshFolder(id);
    },
    needed: () => live().folderOrder.length > 0,
    watch: (changed) => useLive.subscribe((s, prev) => s.folderOrder !== prev.folderOrder && changed()),
  });
  onWindowEvent((e) => {
    if (e.type === "focus") for (const id of live().folderOrder) if (due(id, STALE_ON_FOCUS_MS)) void refreshFolder(id);
  });

  useBrowser.subscribeTo(["windows", "splits", "peeks"], (s, prev) => {
    if (s.windows !== prev.windows || s.splits !== prev.splits || s.peeks !== prev.peeks) closeCompletedTabs();
  });
  onLiveChange((id, now, was) => {
    if (was.playingAudio && !now.playingAudio && useBrowser.getState().tabs[id]) closeCompletedTabs();
  });
  whenCaptureEndsUnderHiddenCompleted(() => closeCompletedTabs());
  useMedia.subscribe((m, prev) => {
    if (m.pipOpen !== prev.pipOpen || m.sessions !== prev.sessions || m.tabShares !== prev.tabShares) closeCompletedTabs();
  });

  useBrowser.subscribeTo(["windows"], (s, prev) => {
    if (s.windows === prev.windows) return;
    for (const windowId of s.windowOrder) {
      const before = activeTabId(prev, windowId);
      if (!before || before === activeTabId(s, windowId)) continue;
      const folderId = s.tabs[before]?.liveItem?.folderId;
      if (!folderId || Date.now() - (lastNudge.get(folderId) ?? 0) < 20_000) continue;
      lastNudge.set(folderId, Date.now());
      const consent = consentToken();
      setTimeout(() => void refreshFolder(folderId, false, consent), 3000);
    }
  });
}
