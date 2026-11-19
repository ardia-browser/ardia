import { LiveError, type LiveItem, type PullRequestSection } from "./types";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";

import { call } from "../../platform/engine";

export const PULLS_PAGE_URL = "https://github.com/pulls/authored";

export const PULLS_PAGE_SCRIPT = `post('result', JSON.stringify((() => {
  const getJson = (path) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false);
    xhr.setRequestHeader('Accept', 'application/json');
    try { xhr.send(); } catch (e) { return null; }
    if (xhr.status !== 200 || (xhr.responseURL || '').indexOf('/login') !== -1) return null;
    try { return JSON.parse(xhr.responseText); } catch (e) { return null; }
  };
  const pick = (json, keys) => {
    let cur = json;
    for (const key of keys) { if (!cur || typeof cur !== 'object') return null; cur = cur[key]; }
    return cur;
  };
  const slimLabels = (r) => {
    if (!Array.isArray(r.labels)) return [];
    return r.labels
      .map((l) => (l && typeof l === 'object') ? { name: l.name, color: l.color } : null)
      .filter((l) => l && typeof l.name === 'string' && typeof l.color === 'string');
  };
  const slim = (r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    url: r.permalink,
    repo: r.repoNameWithOwner,
    author: r.author && r.author.displayLogin,
    updatedAt: r.updatedAt,
    draft: !!r.isDraft,
    comments: r.commentCount == null ? null : r.commentCount,
    category: r.category || null,
    labels: slimLabels(r),
  });
  const slimDeferred = (r) => ({ id: r.id, review: r.reviewDecisionState || null });
  const login = document.querySelector('meta[name="user-login"]')?.content;
  if (!login) return { signedOut: true };
  let error = null;
  const MAX_PAGES = 4;
  const listAll = (first, path, keys) => {
    const out = [];
    const infoKeys = keys.slice(0, -1).concat(['pageInfo']);
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = page === 1 ? first : getJson(path + '?page=' + page);
      if (!json) break;
      let rows;
      try { rows = (pick(json, keys) || []).filter(Boolean).map(slim); }
      catch (e) { error = error || String((e && e.message) || e); rows = []; }
      out.push(...rows);
      const info = pick(json, infoKeys) || {};
      if (!rows.length || Number(info.currentPage) !== page || !(Number(info.totalPages) > page)) break;
    }
    return out;
  };
  const DASHBOARD_KEYS = ['payload', 'pullsDashboardSurfaceContentRoute', 'results'];
  const authoredJson = getJson('/pulls/authored');
  if (!authoredJson) return { signedOut: true };
  const authored = listAll(authoredJson, '/pulls/authored', DASHBOARD_KEYS);
  const reviewsJson = getJson('/pulls/reviews');
  const reviewRequested = reviewsJson ? listAll(reviewsJson, '/pulls/reviews', DASHBOARD_KEYS) : [];
  const conflicts = [];
  for (const filter of ['waiting-for-review', 'ready-to-merge']) {
    const json = getJson('/pulls/inbox/queries?filter=' + filter + '&max_pr_age=1m');
    if (!json) continue;
    try {
      for (const r of pick(json, ['payload', 'pullsInboxSurfaceContentRoute', 'results']) || []) {
        if (r && r.id && r.category === 'MERGE_CONFLICTS' && conflicts.indexOf(r.id) === -1) conflicts.push(r.id);
      }
    } catch (e) { error = error || String((e && e.message) || e); }
  }
  const deferred = [];
  const ids = [].concat(authored, reviewRequested).map((r) => r.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const json = getJson('/pulls/inbox/deferred?page=1&' + chunk.map((id) => 'ids[]=' + encodeURIComponent(id)).join('&'));
    if (!json) continue;
    try { deferred.push(...(pick(json, ['payload', 'pullsInboxSurfaceContentDeferredData', 'results']) || []).filter(Boolean).map(slimDeferred)); } catch (e) { error = error || String((e && e.message) || e); }
  }
  return error ? { signedOut: false, login, error, authored: [], reviewRequested: [], deferred: [], conflicts: [] } : { signedOut: false, login, authored, reviewRequested, deferred, conflicts };
})()))`;

export type PullsLabel = { name: string; color: string };
export type PullsPageItem = { id: string; number: number; title: string; url: string; repo: string; author: string | null; updatedAt: string; draft: boolean; comments: number | null; category: string | null; labels?: PullsLabel[] };
export type PullsPage = { signedOut?: boolean; login?: string; error?: string; authored?: PullsPageItem[]; reviewRequested?: PullsPageItem[]; deferred?: { id: string; review: string | null }[]; conflicts?: string[] };

const pullsPageInFlight = new Map<string, Promise<PullsPage>>();

export async function fetchPullsPage(profileId: string): Promise<PullsPage> {
  const profile = engineProfile(useBrowser.getState(), profileId);
  const inFlight = pullsPageInFlight.get(profile);
  if (inFlight) return inFlight;
  const load = call("engine.sessionPage", { profile, url: PULLS_PAGE_URL, script: PULLS_PAGE_SCRIPT })
    .then((reply) => {
      if (!reply.ok) throw new LiveError("other", reply.reason ?? "The page couldn't be read");
      return (reply.json ?? {}) as PullsPage;
    })
    .finally(() => pullsPageInFlight.delete(profile));
  pullsPageInFlight.set(profile, load);
  return load;
}

export function mapPullsPage(page: PullsPage, filters: { authored: boolean; reviewRequests: boolean }): LiveItem[] {
  if (page.signedOut || page.error) return [];
  const reviews = new Map((page.deferred ?? []).map((d) => [d.id, d.review]));
  const conflicts = new Set(page.conflicts ?? []);
  const mapSection = (rows: PullsPageItem[] | undefined, section: PullRequestSection): LiveItem[] =>
    (rows ?? [])
      .filter((it) => it.repo && it.number && it.title && it.id)
      .map((it): LiveItem => ({
        id: `github:${it.id}`,
        source: "github",
        url: it.url,
        title: it.title,
        subtitle: `${it.repo} #${it.number}`,
        icon: null,
        updatedAt: Date.parse(it.updatedAt) || 0,
        section,
        pr: {
          number: it.number,
          repo: it.repo,
          author: it.author || "ghost",
          authorAvatar: it.author ? `https://github.com/${it.author}.png?size=64` : null,
          draft: it.draft,
          headRef: "",
          baseRef: "",
          review: reviews.get(it.id) === "APPROVED" ? "approved" : reviews.get(it.id) === "CHANGES_REQUESTED" ? "changesRequested" : reviews.get(it.id) === "REVIEW_REQUIRED" ? "required" : null,
          mergeable: it.category === "MERGE_CONFLICTS" || conflicts.has(it.id) ? "conflicting" : "unknown",
          checks: [],
          comments: it.comments,
          unresolvedThreads: 0,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          labels: it.labels,
        },
      }));
  const out: LiveItem[] = [];
  const seen = new Set<string>();
  if (filters.authored) for (const it of mapSection(page.authored, "authored")) if (!seen.has(it.id)) (seen.add(it.id), out.push(it));
  if (filters.reviewRequests) for (const it of mapSection(page.reviewRequested, "review")) if (!seen.has(it.id)) (seen.add(it.id), out.push(it));
  return out;
}
