import type { PageEngine } from "../../platform/tabs";
import { clearSiteData as clearEngineSiteData, type ClearSiteDataResult } from "../../platform/siteSettings";
import { readDocument, writeDocument } from "../../platform/documents";
import { withDeadline } from "../../lib/deadline";
import { parseSaved, unchanged, versionedJson } from "../../lib/savedDocument";
import { coveredBy, domainOfKey, registrableDomain, webOrigin } from "./siteDataMerge";
import { learnRegistrableDomains } from "./siteDataDomains";
import { forgetSessionCookies, readLedger, type Ledger } from "./siteDataLedger";
import { noteSiteDataSkip } from "../telemetry/siteDataCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";

const DOC = "site-data-carry.json";
const DOC_VERSION = 1;
const SAVE_DELAY_MS = 5_000;
const CLEAR_WAIT_MS = 5_000;

export const hostOf = (origin: string) => new URL(origin).hostname;

let ledger: Ledger | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function book(): Ledger {
  if (ledger) return ledger;
  try {
    ledger = readLedger(parseSaved(readDocument(DOC), DOC_VERSION, { 0: unchanged })?.profiles);
  } catch {
    ledger = {};
  }
  forgetSessionCookies(ledger);
  return ledger;
}

export function saveNow(consent: ConsentToken | null) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    writeDocument(DOC, versionedJson({ profiles: book() }, DOC_VERSION));
  } catch {
    noteSiteDataSkip("failure", consent);
  }
}

export function saveSoon(consent: ConsentToken | null) {
  if (!saveTimer) saveTimer = setTimeout(() => saveNow(consent), SAVE_DELAY_MS);
}

const clears = new Map<string, number>();
const clearing = new Map<string, Promise<unknown>>();
export const active = new Map<string, Promise<void>>();
export const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const clearCount = (profile: string) => clears.get(profile) ?? 0;

function abortCarries(profile: string) {
  clears.set(profile, clearCount(profile) + 1);
  for (const [key, timer] of pushTimers)
    if (key.startsWith(`${profile}|`)) {
      clearTimeout(timer);
      pushTimers.delete(key);
    }
}

export async function clearsSettled(profile: string) {
  for (let held = clearing.get(profile); held; held = clearing.get(profile)) await held.catch(() => {});
}

type Turn = { urgent: boolean; go: () => void };
type Lane = { busy: boolean; turns: Turn[] };

const commitLanes = new Map<string, Lane>();
type Commit = { at: number; domains: readonly string[]; origins: readonly string[] };
type CommitLog = { count: number; recent: Commit[] };

const MAX_RECENT_COMMITS = 64;
const commits = new Map<string, CommitLog>();

export const commitCount = (profile: string) => commits.get(profile)?.count ?? 0;

export function noteCommit(profile: string, domains: readonly string[], origins: readonly string[]) {
  const log = commits.get(profile) ?? { count: 0, recent: [] };
  log.count++;
  log.recent.push({ at: log.count, domains, origins });
  if (log.recent.length > MAX_RECENT_COMMITS) log.recent.shift();
  commits.set(profile, log);
}

const sharesDomain = (a: readonly string[], b: readonly string[]) => a.some((x) => coveredBy(x, b)) || b.some((y) => coveredBy(y, a));

export function committedSince(profile: string, seen: number, domains: readonly string[], origins: readonly string[]): boolean {
  const log = commits.get(profile);
  if (!log || log.count === seen) return false;
  const since = log.recent.filter((c) => c.at > seen);
  if (since.length < log.count - seen) return true;
  return since.some((c) => sharesDomain(c.domains, domains) || c.origins.some((o) => origins.includes(o)));
}

function waitForTurn(lane: Lane, urgent: boolean): Promise<void> {
  return new Promise((go) => {
    const turn = { urgent, go };
    const behind = urgent ? lane.turns.findIndex((t) => !t.urgent) : -1;
    if (behind < 0) lane.turns.push(turn);
    else lane.turns.splice(behind, 0, turn);
  });
}

export async function inCommitLane<T>(profile: string, urgent: boolean, job: () => Promise<T>): Promise<T> {
  const lane = commitLanes.get(profile) ?? { busy: false, turns: [] };
  commitLanes.set(profile, lane);
  if (lane.busy) await waitForTurn(lane, urgent);
  lane.busy = true;
  let finished = () => {};
  active.set(profile, new Promise<void>((resolve) => (finished = resolve)));
  try {
    return await job();
  } finally {
    active.delete(profile);
    finished();
    const next = lane.turns.shift();
    if (next) next.go();
    else {
      lane.busy = false;
      commitLanes.delete(profile);
    }
  }
}

function holdCarriesWhile<T>(profile: string, consent: ConsentToken | null, clear: () => Promise<T>, settle: () => void): Promise<T> {
  abortCarries(profile);
  const prior = clearing.get(profile);
  const run = (async () => {
    if (prior) await prior.catch(() => {});
    const running = active.get(profile);
    if (running && !(await withDeadline(running.then(() => true), CLEAR_WAIT_MS, false))) noteSiteDataSkip("clearWaitTimeout", consent);
    return clear();
  })();
  const held: Promise<T> = run.finally(() => {
    abortCarries(profile);
    settle();
    if (clearing.get(profile) === held) clearing.delete(profile);
  });
  clearing.set(profile, held);
  return held;
}

export function whileClearingSiteData<T>(profile: string, types: readonly string[], clear: () => Promise<T>): Promise<T> {
  const consent = consentToken();
  return holdCarriesWhile(profile, consent, clear, () => {
    const p = book()[profile];
    if (!p) return;
    if (types.includes("siteData")) {
      p.cookies = {};
      p.storage = {};
    }
    if (types.includes("history")) p.sites = {};
    if (types.includes("siteData") || types.includes("history")) saveNow(consent);
  });
}

function forgetSiteBases(profile: string, origin: string) {
  const p = book()[profile];
  const host = webOrigin(origin) ? hostOf(origin) : "";
  if (!p || !host) return;
  const reach = [...new Set([host, registrableDomain(host)])];
  for (const key of Object.keys(p.cookies)) if (coveredBy(domainOfKey(key), reach)) delete p.cookies[key];
  for (const o of Object.keys(p.storage)) if (coveredBy(hostOf(o), reach)) delete p.storage[o];
}

const emptyClear: ClearSiteDataResult = { cookies: false, storage: false };

export async function clearSiteDataEverywhere(profile: string, origin: string): Promise<ClearSiteDataResult> {
  const consent = consentToken();
  const host = webOrigin(origin) ? hostOf(origin) : "";
  if (host) await learnRegistrableDomains([host]);
  const engines: PageEngine[] = ["chromium", "webkit"];
  const results = await holdCarriesWhile(
    profile,
    consent,
    () => Promise.all(engines.map((engine) => clearEngineSiteData(profile, origin, engine).catch(() => emptyClear))),
    () => {
      forgetSiteBases(profile, origin);
      saveNow(consent);
    },
  );
  const counted = results.filter((r): r is ClearSiteDataResult & { cookies: number } => typeof r.cookies === "number");
  return {
    cookies: counted.length ? counted.reduce((n, r) => n + r.cookies, 0) : false,
    storage: results.some((r) => r.storage),
  };
}

export function forgetSiteDataProfile(profile: string) {
  abortCarries(profile);
  if (!(profile in book())) return;
  delete book()[profile];
  saveNow(consentToken());
}

export function resetSiteDataStateForTest() {
  ledger = null;
  clears.clear();
  clearing.clear();
  commitLanes.clear();
  commits.clear();
  active.clear();
  for (const timer of pushTimers.values()) clearTimeout(timer);
  pushTimers.clear();
}
