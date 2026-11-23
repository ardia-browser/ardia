import { addHistoryVisits, deleteHistoryUrls } from "../../platform/history";
import type { Adapter } from "../../platform/sync";
import { historyOf, historyViewOf, MAX_HISTORY, MAX_VISIT_TIMES, withHistoryList, type HistoryView } from "../history/history";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import type { HistoryEntry } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { HISTORY, historyValue, recordId, type HistoryValue } from "./records";
import { consentToken } from "../telemetry/client";
import { noteSyncHistoryTitlesKept, withSyncWorkCounts } from "../telemetry/workCounts";
import { historyExtractsOf } from "./historyExtracts";

const store = () => useBrowser.getState();

const HISTORY_WINDOW_MS = 90 * 86_400_000;

const lastVisitOf = (v: HistoryValue) => v.vt.reduce((m, t) => Math.max(m, t), 0);
const SAME_VISIT_MS = 1;
const keptVisits = (vt: number[]) => {
  if (vt.length <= MAX_VISIT_TIMES) return vt;
  const out: number[] = [];
  for (const t of [...vt].sort((a, z) => a - z)) if (!out.length || t - out[out.length - 1]! > SAME_VISIT_MS) out.push(t);
  return out.slice(-MAX_VISIT_TIMES);
};
const sameVisits = (a: number[], b: number[]) => a.length === b.length && a.every((t, i) => Math.abs(b[i]! - t) <= SAME_VISIT_MS);

export function historyExpired(key: string, value: unknown, now: number) {
  const v = key.startsWith(HISTORY) ? historyValue(value) : null;
  return !!v && lastVisitOf(v) < now - HISTORY_WINDOW_MS;
}

const newestFirstLists = new WeakMap<readonly HistoryEntry[], boolean>();

function newestFirst(view: readonly HistoryEntry[]): boolean {
  let sorted = newestFirstLists.get(view);
  if (sorted === undefined) {
    sorted = true;
    for (let i = 1; i < view.length && sorted; i++) sorted = view[i]!.lastVisit <= view[i - 1]!.lastVisit;
    newestFirstLists.set(view, sorted);
  }
  return sorted;
}

function olderThan(view: readonly HistoryEntry[], since: number, keyOf: (e: HistoryEntry) => string | null): (key: string) => boolean {
  let older: Set<string> | undefined;
  return (key) => {
    if (!older) {
      older = new Set();
      for (const e of view) {
        if (e.lastVisit >= since) continue;
        const k = keyOf(e);
        if (k !== null) older.add(k);
      }
    }
    return older.has(key);
  };
}

type ExtractedWindow = { since: number };
const extractedWindows = new WeakMap<HistoryView, ExtractedWindow>();

function windowToken(view: HistoryView | undefined, since: number): ExtractedWindow | undefined {
  if (!view) return undefined;
  const token = extractedWindows.get(view);
  if (token && since >= token.since) return token;
  const fresh = { since };
  extractedWindows.set(view, fresh);
  return fresh;
}

export function historyAdapter(profileId: string): Adapter {
  const ready = () => !!historyViewOf(store(), profileId)?.ready;
  const extracts = historyExtractsOf(profileId);
  const { parsed, knownJson } = extracts;
  const knownOf = (key: string, json: string | undefined) => {
    if (json === undefined) return null;
    const cached = parsed.get(key);
    if (cached?.json === json) return cached.known;
    const known = historyValue(JSON.parse(json));
    parsed.set(key, { json, known });
    if (known) knownJson.set(known, json);
    return known;
  };
  const visitOf = (key: string, e: HistoryEntry, json: string | undefined): HistoryValue => {
    const local: HistoryValue = { t: e.title, n: e.visits, vt: e.visitTimes?.length ? e.visitTimes : [e.lastVisit] };
    const known = knownOf(key, json);
    const edited = !known || (!sameVisits(local.vt, known.vt) && local.vt.some((t) => !known.vt.some((k) => Math.abs(k - t) <= SAME_VISIT_MS)));
    return edited ? local : known;
  };
  return withSyncWorkCounts("history", {
    prefix: HISTORY,
    extractsOnlyFrom: () => windowToken(historyViewOf(store(), profileId), Date.now() - HISTORY_WINDOW_MS),
    extract: (_base, _queued, _now, _known, _remote, _stamp, baseJson) => {
      if (!ready()) return null;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const values = new Map<string, unknown>();
      const current = historyViewOf(store(), profileId)!;
      const token = extractedWindows.get(current);
      if (token) token.since = Math.max(token.since, since);
      const { list: view, floor } = current;
      const extractedVisit = (e: HistoryEntry) => {
        let visit = extracts.visits.get(e);
        if (!visit) extracts.visits.set(e, (visit = { key: isWebPageUrl(e.url) ? `${HISTORY}${e.url}` : null, json: undefined, value: null }));
        return visit;
      };
      const stopsAtWindow = newestFirst(view);
      const isOlder = olderThan(view, since, (e) => extractedVisit(e).key);
      for (let i = 0; i < view.length; i++) {
        const e = view[i]!;
        if (e.lastVisit < since) {
          if (stopsAtWindow) break;
          continue;
        }
        const visit = extractedVisit(e);
        const { key } = visit;
        if (key === null) continue;
        const json = baseJson(key);
        if (visit.value === null || visit.json !== json) Object.assign(visit, { json, value: visitOf(key, e, json) });
        values.set(key, visit.value);
      }
      if (parsed.size > 2 * values.size + 1000) for (const key of parsed.keys()) if (!values.has(key) && baseJson(key) === undefined) parsed.delete(key);
      const ignore = (key: string) => {
        if (isOlder(key) || !isWebPageUrl(recordId(HISTORY, key))) return true;
        const known = knownOf(key, baseJson(key));
        return !!known && (lastVisitOf(known) < since || lastVisitOf(known) <= floor);
      };
      const json = (_key: string, value: unknown) => knownJson.get(value as HistoryValue);
      return { values, ignore, json };
    },
    editedAt: (v) => {
      const value = historyValue(v);
      return value ? lastVisitOf(value) : undefined;
    },
    apply: async (visible, changed) => {
      if (!ready()) return false;
      const since = Date.now() - HISTORY_WINDOW_MS;
      const byUrl = new Map(historyOf(store(), profileId).map((e) => [e.url, e]));
      const add: { url: string; title: string; visitTimes: number[] }[] = [];
      const remove: string[] = [];
      const updates = new Map<string, HistoryEntry | null>();
      for (const key of changed) {
        const url = recordId(HISTORY, key);
        if (!isWebPageUrl(url)) continue;
        const v = historyValue(visible.get(key));
        if (visible.has(key) && !v) return false;
        const old = byUrl.get(url);
        if (v) {
          const have = old?.visitTimes ?? [];
          const fresh = keptVisits(v.vt).filter((t) => t >= since && !have.some((h) => Math.abs(h - t) <= SAME_VISIT_MS));
          if (fresh.length) add.push({ url, title: v.t, visitTimes: fresh });
          const times = [...have, ...fresh].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
          if (!times.length) continue;
          updates.set(url, {
            url,
            title: v.t || old?.title || "",
            favicon: null,
            visits: Math.max(v.n, old?.visits ?? 0),
            lastVisit: times[times.length - 1]!,
            visitTimes: times,
          });
        } else if (old && old.lastVisit >= since) {
          remove.push(url);
          updates.set(url, null);
        }
      }
      if (!updates.size) return;
      const engine = engineProfile(useBrowser.getState(), profileId);
      const consent = consentToken();
      await Promise.all([addHistoryVisits(engine, add, SAME_VISIT_MS), deleteHistoryUrls(engine, remove)]);
      let titlesKept = 0;
      useBrowser.setState((s) => {
        const current = new Map(historyOf(s, profileId).map((e) => [e.url, e]));
        for (const [url, update] of updates) {
          const now = current.get(url);
          if (!update) current.delete(url);
          else if (!now) current.set(url, update);
          else {
            const times = [...new Set([...(now.visitTimes ?? []), ...(update.visitTimes ?? [])])].sort((a, z) => a - z).slice(-MAX_VISIT_TIMES);
            if (now.title && now.title !== update.title) titlesKept++;
            current.set(url, { ...update, title: now.title || update.title, visits: Math.max(now.visits, update.visits), lastVisit: times[times.length - 1]!, visitTimes: times });
          }
        }
        const list = [...current.values()].sort((a, z) => z.lastVisit - a.lastVisit).slice(0, MAX_HISTORY);
        return withHistoryList(s, engine, list);
      });
      if (titlesKept) noteSyncHistoryTitlesKept(titlesKept, consent);
    },
  });
}
