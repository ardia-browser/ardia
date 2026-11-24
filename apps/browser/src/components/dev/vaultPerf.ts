import { currentEngineProfile, currentSettings } from "../../state/browser/current";
import { unlockPasswordsFor } from "../../state/site/savedPasswords";
import { openPasswordSettings } from "../../state/vaults/actions";
import { nameOf, walk, type Fiber } from "../../state/app/perfFibers";
import { fresh } from "../../state/app/perfStats";

type Hook = { getFiberRoots?: (id: number) => Set<{ current: Fiber }>; onCommitFiberRoot: (...a: unknown[]) => unknown };

const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
const TICK_MS = 4;
const LONG_TASK_MS = 50;
const QUIET_MS = 400;

let commits: number[] = [];
let wrapped = false;
let renderStats = fresh();

function watchCommits() {
  if (wrapped || !hook) return;
  wrapped = true;
  const original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = (...args: unknown[]) => {
    commits.push(performance.now());
    const root = args[1] as { current: Fiber } | undefined;
    if (root?.current) walk(root.current, renderStats, false);
    return original(...args);
  };
}

type Monitor = { gaps: number[]; last: number; timer: ReturnType<typeof setTimeout> | null };
let monitor: Monitor | null = null;

function beat() {
  if (!monitor) return;
  const now = performance.now();
  monitor.gaps.push(now - monitor.last);
  monitor.last = now;
  monitor.timer = setTimeout(beat, TICK_MS);
}

export function startMonitor() {
  watchCommits();
  if (monitor?.timer) clearTimeout(monitor.timer);
  commits = [];
  renderStats = fresh();
  monitor = { gaps: [], last: performance.now(), timer: null };
  monitor.timer = setTimeout(beat, TICK_MS);
}

export function stopMonitor() {
  const taken = monitor;
  if (taken?.timer) clearTimeout(taken.timer);
  monitor = null;
  const gaps = taken?.gaps ?? [];
  const long = gaps.filter((g) => g >= LONG_TASK_MS);
  return {
    longTasks: long.length,
    maxGapMs: Math.round(Math.max(0, ...gaps)),
    blockedMs: Math.round(gaps.filter((g) => g > 17).reduce((sum, g) => sum + g - TICK_MS, 0)),
    commits: commits.length,
    renders: top(renderStats.renders),
    mounts: top(renderStats.mounts),
  };
}

function top(counts: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function settled(since: number, budgetMs = 20_000): Promise<number> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    await wait(50);
    const last = commits.length ? commits[commits.length - 1]! : since;
    if (performance.now() - Math.max(last, since) >= QUIET_MS || performance.now() > deadline) return Math.round(Math.max(last, since) - since);
  }
}

function rootFibers(): Fiber[] {
  const roots = hook?.getFiberRoots?.(1);
  return roots ? [...roots].map((r) => r.current) : [];
}

function find(fiber: Fiber | null, match: (f: Fiber) => boolean, out: Fiber[] = []): Fiber[] {
  for (let f = fiber; f; f = f.sibling) {
    if (match(f)) out.push(f);
    find(f.child, match, out);
  }
  return out;
}

function paneFiber(): Fiber | null {
  for (const root of rootFibers()) {
    const found = find(root, (f) => nameOf(f.type) === "PasswordsPage");
    if (found[0]) return found[0];
  }
  return null;
}

export function mountedRows(): number {
  const pane = paneFiber();
  if (!pane) return -1;
  return find(pane.child, (f) => nameOf(f.type) === "Row" && typeof f.memoizedProps?.onPress === "function").length;
}

function searchProps(): { onChangeText: (t: string) => void } | null {
  const pane = paneFiber();
  if (!pane) return null;
  const field = find(pane.child, (f) => nameOf(f.type) === "SearchField" && f.memoizedProps?.placeholder === "Search")[0];
  return (field?.memoizedProps as { onChangeText: (t: string) => void } | undefined) ?? null;
}

function settingsScroller(): { scrollTo: (o: { y: number; animated: boolean }) => void } | null {
  for (const root of rootFibers()) {
    if (!find(root, (f) => nameOf(f.type) === "PasswordsPage").length) continue;
    const found = find(root, (f) => nameOf(f.type) === "ScrollView" && typeof f.memoizedProps?.onScroll === "function" && f.memoizedProps?.scrollEventThrottle === 16);
    for (const f of found) {
      const node = f.stateNode as { scrollTo?: unknown } | null;
      if (f.tag === 1 && node && typeof node.scrollTo === "function") return node as never;
      let child = f.child;
      while (child) {
        const inner = child.stateNode as { scrollTo?: unknown } | null;
        if (inner && typeof inner.scrollTo === "function") return inner as never;
        child = child.child;
      }
    }
  }
  return null;
}

export async function openPasswords() {
  watchCommits();
  const profileId = currentSettings().defaultProfileId;
  await unlockPasswordsFor(currentEngineProfile(profileId));
  startMonitor();
  const t0 = performance.now();
  openPasswordSettings(profileId);
  const ms = await settled(t0);
  return { openMs: ms, rows: mountedRows(), ...stopMonitor() };
}

export async function typeQuery(text: string, everyMs = 120) {
  const props = searchProps();
  if (!props) return null;
  startMonitor();
  const keys: number[] = [];
  for (let i = 1; i <= text.length; i++) {
    const t0 = performance.now();
    searchProps()!.onChangeText(text.slice(0, i));
    await wait(0);
    keys.push(Math.round(performance.now() - t0));
    await wait(everyMs);
  }
  const t0 = performance.now();
  const settle = await settled(t0);
  return { keyMs: keys, settleMs: settle, rows: mountedRows(), ...stopMonitor() };
}

export async function clearQuery() {
  const props = searchProps();
  if (!props) return null;
  startMonitor();
  const t0 = performance.now();
  props.onChangeText("");
  const settle = await settled(t0);
  return { settleMs: settle, rows: mountedRows(), ...stopMonitor() };
}

export async function scrollBy(totalPx: number, stepPx = 120, everyMs = 16) {
  const scroller = settingsScroller();
  if (!scroller) return null;
  startMonitor();
  const t0 = performance.now();
  for (let y = stepPx; y <= totalPx; y += stepPx) {
    scroller.scrollTo({ y, animated: false });
    await wait(everyMs);
  }
  const wall = performance.now() - t0;
  const settle = await settled(performance.now());
  return { wallMs: Math.round(wall), settleMs: settle, rows: mountedRows(), ...stopMonitor() };
}

export function scrollTop() {
  settingsScroller()?.scrollTo({ y: 0, animated: false });
}

function firstLoginRow(): (() => void) | null {
  const pane = paneFiber();
  if (!pane) return null;
  const row = find(pane.child, (f) => nameOf(f.type) === "PasswordRow" && !!f.memoizedProps?.entry)[0];
  if (row) {
    const props = row.memoizedProps as { entry: unknown; onOpen: (e: unknown) => void };
    return () => props.onOpen(props.entry);
  }
  const plain = find(pane.child, (f) => nameOf(f.type) === "Row" && typeof f.memoizedProps?.onPress === "function" && typeof f.memoizedProps?.description === "string" && /@|username/i.test(String(f.memoizedProps?.description)))[0];
  return plain ? (plain.memoizedProps as { onPress: () => void }).onPress : null;
}

function buttonTitled(title: string): (() => void) | null {
  for (const root of rootFibers()) {
    const found = find(root, (f) => nameOf(f.type) === "Button" && f.memoizedProps?.title === title && typeof f.memoizedProps?.onPress === "function");
    const last = found[found.length - 1];
    if (last) return (last.memoizedProps as { onPress: () => void }).onPress;
  }
  return null;
}

async function timed(action: (() => void) | null) {
  if (!action) return null;
  startMonitor();
  const t0 = performance.now();
  action();
  const settle = await settled(t0);
  return { settleMs: settle, ...stopMonitor() };
}

export const openFirstLogin = () => timed(firstLoginRow());
export const openEdit = () => timed(buttonTitled("Edit"));

export async function typeInField(placeholder: string, text: string, everyMs = 120) {
  const field = () => {
    for (const root of rootFibers()) {
      const found = find(root, (f) => typeof f.memoizedProps?.onChangeText === "function" && f.memoizedProps?.placeholder === placeholder);
      if (found[0]) return found[0].memoizedProps as { onChangeText: (t: string) => void; value?: string };
    }
    return null;
  };
  if (!field()) return null;
  startMonitor();
  const keys: number[] = [];
  for (let i = 1; i <= text.length; i++) {
    const t0 = performance.now();
    field()!.onChangeText(text.slice(0, i));
    await wait(0);
    keys.push(Math.round(performance.now() - t0));
    await wait(everyMs);
  }
  const settle = await settled(performance.now());
  return { keyMs: keys, settleMs: settle, ...stopMonitor() };
}

export async function closeSheet() {
  const { closeSettingsSheet } = require("../../state/settings/sheet") as typeof import("../../state/settings/sheet");
  closeSettingsSheet();
  await wait(300);
  return {};
}
