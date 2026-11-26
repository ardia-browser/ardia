import { pageCommitsFlowing, reportPageCommits } from "../../platform/tabs";
import { consentToken, type ConsentToken } from "../telemetry/choice";

export type PageCommit = { seq: number; tabId: string; url: string; at: number; sameDocument: boolean; consent: ConsentToken | null };

export const COMMIT_REREGISTER_BASE_MS = 250;
const COMMIT_REREGISTER_MAX_MS = 60_000;
const MAX_LOGGED_COMMITS = 5000;
const MAX_IDLE_BASELINES = 2000;

const latest = new Map<string, { url: string; at: number }>();
let log: PageCommit[] = [];
let seq = 0;
let listener: (() => void) | null = null;
let listeningSince = 0;
let reported = false;
let reregisterTimer: ReturnType<typeof setTimeout> | null = null;
let reregisterDelay = COMMIT_REREGISTER_BASE_MS;

export function notePluginStateCommit(tabId: string, url: string | undefined, at: number | undefined) {
  if (!url || at === undefined || !Number.isFinite(at) || url === "about:blank") return;
  const last = latest.get(tabId);
  if (!listener) {
    if (!last && latest.size >= MAX_IDLE_BASELINES) latest.clear();
    latest.set(tabId, { url, at: Math.max(at, last?.at ?? at) });
    return;
  }
  if (!last) {
    latest.set(tabId, { url, at });
    if (at <= listeningSince) return;
  } else if (at <= last.at && url === last.url) return;
  const sameDocument = !!last && at <= last.at;
  latest.set(tabId, { url, at: Math.max(at, last?.at ?? at) });
  log.push({ seq: ++seq, tabId, url, at, sameDocument, consent: consentToken() });
  if (log.length > MAX_LOGGED_COMMITS) log = log.slice(-MAX_LOGGED_COMMITS);
  listener();
}

export const commitCursor = () => seq;

export function commitsAfter(cursor: number): PageCommit[] {
  const byTab = new Map<string, PageCommit>();
  for (const commit of log) if (commit.seq > cursor) byTab.set(commit.tabId, commit);
  return [...byTab.values()].sort((a, b) => a.seq - b.seq);
}

export function forgetCommitsThrough(cursor: number) {
  if (log.length && log[0]!.seq <= cursor) log = log.filter((c) => c.seq > cursor);
}

function register() {
  reported = true;
  void reportPageCommits("pluginState", true).then(
    () => {
      reregisterDelay = COMMIT_REREGISTER_BASE_MS;
    },
    () => {
      reported = false;
      scheduleReregister();
    },
  );
}

function scheduleReregister() {
  if (!listener || reregisterTimer) return;
  reregisterTimer = setTimeout(() => {
    reregisterTimer = null;
    if (listener && !reported) register();
  }, reregisterDelay);
  reregisterDelay = Math.min(reregisterDelay * 2, COMMIT_REREGISTER_MAX_MS);
}

export function listenForPluginStateCommits(on: (() => void) | null) {
  const wasOn = !!listener;
  listener = on;
  if (!on && wasOn) {
    void reportPageCommits("pluginState", false).catch(() => {});
    if (!pageCommitsFlowing()) latest.clear();
  }
  if (!!on !== wasOn) {
    if (on && !pageCommitsFlowing()) latest.clear();
    log = [];
    listeningSince = Date.now();
    reported = false;
    reregisterDelay = COMMIT_REREGISTER_BASE_MS;
    if (reregisterTimer) clearTimeout(reregisterTimer);
    reregisterTimer = null;
  }
  if (on && !reported) register();
}
