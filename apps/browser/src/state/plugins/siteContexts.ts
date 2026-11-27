import { create } from "zustand";
import type { WebViewHandle } from "../../platform/tabs";
import { withDeadline } from "../../lib/deadline";
import { isFields } from "../../lib/decode";
import { secureRandomHex } from "../../platform/secureRandom";
import type { SiteTransport } from "./siteRules";
import { hostFetch } from "./hostIo";

export type SiteContextView = { key: string; plugin: string; origin: string; anchor: string; profile: string; windowId: string };

export const SITE_CONTEXT_LIMITS = { attachMs: 8000, readyMs: 20_000, probeStepMs: 250, idleMs: 60_000, perPlugin: 8, preflightMs: 10_000 } as const;

export const useSiteContexts = create<{ contexts: Record<string, SiteContextView> }>()(() => ({ contexts: {} }));

type Live = { view: SiteContextView; handle: WebViewHandle | null; attached: Array<(handle: WebViewHandle | null) => void>; ready: Promise<boolean> | null; busy: number; idle: ReturnType<typeof setTimeout> | null; gone: Promise<null>; end: () => void };

const live = new Map<string, Live>();

export const anchorOf = (origin: string) => `${origin}/robots.txt`;

function publish() {
  const contexts: Record<string, SiteContextView> = {};
  for (const [key, l] of live) contexts[key] = l.view;
  useSiteContexts.setState({ contexts });
}

function holdOpen(l: Live) {
  if (l.idle) clearTimeout(l.idle);
  l.idle = null;
}

function closeWhenIdle(l: Live) {
  holdOpen(l);
  if (l.busy > 0) return;
  l.idle = setTimeout(() => {
    if (live.get(l.view.key) === l && l.busy === 0) dropContext(l.view.key);
  }, SITE_CONTEXT_LIMITS.idleMs);
  (l.idle as { unref?: () => void }).unref?.();
}

export function dropContext(key: string) {
  const l = live.get(key);
  if (!l) return;
  live.delete(key);
  holdOpen(l);
  l.end();
  for (const wake of l.attached.splice(0)) wake(null);
  publish();
}

export function dropPluginContexts(plugin: string) {
  for (const [key, l] of [...live]) if (l.view.plugin === plugin) dropContext(key);
}

export function dropWindowContexts(windowId: string) {
  for (const [key, l] of [...live]) if (l.view.windowId === windowId) dropContext(key);
}

export function attachSiteContext(key: string, handle: WebViewHandle | null) {
  const l = live.get(key);
  if (!l) return;
  if (!handle) {
    if (l.handle) dropContext(key);
    return;
  }
  l.handle = handle;
  for (const wake of l.attached.splice(0)) wake(handle);
}

const PROBE = `post("result", JSON.stringify({ origin: location.origin, ready: document.readyState !== "loading", plain: !!document.contentType && !/html|xml|svg/i.test(document.contentType) }))`;

type Probe = { origin?: unknown; ready?: unknown; plain?: unknown };

async function waitReady(l: Live): Promise<boolean> {
  const handle = l.handle ?? (await withDeadline(new Promise<WebViewHandle | null>((resolve) => l.attached.push(resolve)), SITE_CONTEXT_LIMITS.attachMs, null));
  if (!handle || live.get(l.view.key) !== l) return false;
  const until = Date.now() + SITE_CONTEXT_LIMITS.readyMs;
  while (Date.now() < until && live.get(l.view.key) === l) {
    const probe = (await withDeadline(handle.evaluate<Probe>(PROBE).catch(() => null), 2000, null)) as Probe | null;
    if (isFields(probe) && probe.origin === l.view.origin && probe.ready === true) return probe.plain === true;
    await new Promise((resolve) => setTimeout(resolve, SITE_CONTEXT_LIMITS.probeStepMs));
  }
  return false;
}

export async function anchorStaysOnOrigin(origin: string): Promise<string | null> {
  const host = new URL(origin).host;
  const answer = await hostFetch({ url: anchorOf(origin), method: "GET", headers: {}, timeoutMs: SITE_CONTEXT_LIMITS.preflightMs, allowedHosts: [host] });
  if (!answer.ok) return `${host} couldn't be reached without your sign-in, or sent Ardia somewhere else (${answer.reason.slice(0, 200)}).`;
  let landed: string | null = null;
  try {
    landed = new URL(answer.url).origin;
  } catch {}
  return landed === origin ? null : `${host} sent Ardia to another site, which it never follows with your sign-in.`;
}

export function noteContextNavigation(key: string, url: string) {
  const l = live.get(key);
  if (!l) return;
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {}
  if (url && url !== "about:blank" && origin !== l.view.origin) dropContext(key);
}

export type ContextOutcome = { ok: true; key: string } | { ok: false; reason: string };

export async function openSiteContext(plugin: string, origin: string, profile: string, windowId: string): Promise<ContextOutcome> {
  const found = [...live.values()].find((l) => l.view.plugin === plugin && l.view.origin === origin && l.view.profile === profile && l.view.windowId === windowId);
  let l = found;
  if (!l) {
    if ([...live.values()].filter((x) => x.view.plugin === plugin).length >= SITE_CONTEXT_LIMITS.perPlugin) return { ok: false, reason: "This plugin has too many sites open at once." };
    const leaves = await anchorStaysOnOrigin(origin);
    if (leaves) return { ok: false, reason: leaves };
    const raced = [...live.values()].find((x) => x.view.plugin === plugin && x.view.origin === origin && x.view.profile === profile && x.view.windowId === windowId);
    if (raced) return openSiteContext(plugin, origin, profile, windowId);
    if ([...live.values()].filter((x) => x.view.plugin === plugin).length >= SITE_CONTEXT_LIMITS.perPlugin) return { ok: false, reason: "This plugin has too many sites open at once." };
    const key = `s${secureRandomHex(10)}`;
    let end = () => {};
    const gone = new Promise<null>((resolve) => (end = () => resolve(null)));
    l = { view: { key, plugin, origin, anchor: anchorOf(origin), profile, windowId }, handle: null, attached: [], ready: null, busy: 0, idle: null, gone, end };
    live.set(key, l);
    publish();
  }
  const mine = l;
  mine.busy++;
  holdOpen(mine);
  mine.ready ??= waitReady(mine);
  const ready = await mine.ready;
  mine.busy--;
  closeWhenIdle(mine);
  if (!ready) {
    if (live.get(mine.view.key) === mine) dropContext(mine.view.key);
    return { ok: false, reason: `${new URL(origin).host} didn't load in Ardia, or answered with something other than its own page.` };
  }
  return live.get(mine.view.key) === mine ? { ok: true, key: mine.view.key } : { ok: false, reason: "The window the site was open in closed." };
}

export async function runInContext<T>(key: string, script: string, ms: number, stop?: Promise<unknown>): Promise<T | null> {
  const l = live.get(key);
  if (!l?.handle) return null;
  l.busy++;
  holdOpen(l);
  try {
    const answer = withDeadline(l.handle.evaluate<T>(script).catch(() => null), ms, null);
    return (await Promise.race([answer, l.gone, ...(stop ? [stop.then(() => null)] : [])])) as T | null;
  } finally {
    l.busy--;
    if (live.get(key) === l) closeWhenIdle(l);
  }
}

export const contextAlive = (key: string) => !!live.get(key)?.handle;

export const liveContextCount = () => live.size;

export async function stillOnItsOrigin(key: string): Promise<boolean> {
  const l = live.get(key);
  if (!l?.handle) return false;
  const probe = await runInContext<Probe>(key, PROBE, 2000);
  const holds = isFields(probe) && probe.origin === l.view.origin && probe.ready === true && probe.plain === true;
  if (!holds && live.get(key) === l) dropContext(key);
  return holds;
}

async function runChecked<T>(key: string, script: string, ms: number, stop?: Promise<unknown>): Promise<T | null> {
  if (!(await stillOnItsOrigin(key))) return null;
  return runInContext<T>(key, script, ms, stop);
}

export const hiddenPageTransport: SiteTransport = {
  open: (plugin, origin, place) => openSiteContext(plugin, origin, place.profile, place.windowId),
  run: (key, script, ms, stop) => runChecked(key, script, ms, stop),
  alive: contextAlive,
  dropPlugin: dropPluginContexts,
};
