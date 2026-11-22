import { blockedError, blockedNodes, changeKey, DETAILS_PAGE, detailNodes, GITHUB_DETAILS_QUERY, GITHUB_DIRECT_QUERY, GITHUB_SEARCH_QUERY, GITHUB_SEARCHES, GITHUB_STATE_QUERY, isClassicPat, listingOf, prItem, restItems, restQuery, sectioned, VIEWER_QUERY, withStacks, type DetailsResponse, type GithubResponse, type ListedPR, type Listing, type RateLimitInfo, type RestSearch, type SearchResponse } from "./github";
import { createGithubLimits, graphqlRateLimited, retryAtFromHeaders, type GithubLimits, type HeaderReader } from "./githubLimits";
import { LiveError, type CompletionState, type LiveFolder, type LiveItem, type PullRequestSection } from "./types";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteLiveGithubBlocked, noteLiveGithubDetails, noteLiveGithubRequest, noteLiveGithubRest } from "../telemetry/liveGithub";

export const LIST_SHARED_MS = 30_000;
export const DETAILS_FRESH_MS = 10 * 60_000;
export const PENDING_FRESH_MS = 60_000;

export type GraphqlPayload = { query: string; variables: Record<string, unknown> };
export type GithubSend = (scope: string, payload: GraphqlPayload, onHeaders: (headers: HeaderReader) => void) => Promise<unknown>;
export type GithubRestSend = (scope: string, q: string, onHeaders: (headers: HeaderReader) => void) => Promise<unknown>;

type Reply = { data?: { rateLimit?: RateLimitInfo | null } | null; errors?: { type?: string; message: string }[] };
type Listed = Listing & { keys: Map<string, string | null>; blocked: LiveError | null; rest: Map<string, LiveItem> };
const SEARCH_KINDS = ["authored", "review", "direct"] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];
type Searches = Record<SearchKind, SearchResponse>;
type RestResult = { items: LiveItem[]; complete: boolean } | "held" | "failed";
type Detail = {
  key: string | null;
  at: number;
  item: LiveItem | null;
  bySection: Partial<Record<PullRequestSection, LiveItem>>;
  stacked: { from: LiveItem; item: LiveItem } | null;
};
type Account = {
  scope: string;
  list: { at: number; done: boolean; promise: Promise<Listed> } | null;
  details: Map<string, Detail>;
  pending: Map<string, Promise<void>>;
  blocked: LiveError | null;
};

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

const unsettled = (item: LiveItem | null) => !!item?.pr?.checks.some((c) => c.state === "pending" || c.state === "queued");

export function createGithubClient(send: GithubSend, clock: () => number = Date.now, limits: GithubLimits = createGithubLimits(clock), rest: GithubRestSend | null = null) {
  let current: Account | null = null;

  const restScope = (scope: string) => `${scope}:rest`;

  const account = (scope: string): Account => {
    if (current?.scope === scope) return current;
    if (current) {
      limits.forget(current.scope);
      limits.forget(restScope(current.scope));
    }
    return (current = { scope, list: null, details: new Map(), pending: new Map(), blocked: null });
  };

  async function graphql<T extends Reply>(scope: string, interactive: boolean, query: string, variables: Record<string, unknown>): Promise<T> {
    return limits.withSlot(async () => {
      if (limits.blockedUntil(scope, interactive) !== null) {
        noteLiveGithubRequest("held");
        throw new LiveError("rateLimited", "Waiting for the GitHub rate limit to reset");
      }
      let headers: HeaderReader | null = null;
      const limited = () => {
        noteLiveGithubRequest("rateLimited");
        limits.rateLimited(scope, retryAtFromHeaders(headers, clock()));
        return new LiveError("rateLimited", "Rate Limit Exceeded");
      };
      noteLiveGithubRequest("sent");
      let json: T;
      try {
        json = (await send(scope, { query, variables }, (h) => {
          headers = h;
          limits.observe(scope, h);
        })) as T;
      } catch (error) {
        throw error instanceof LiveError && error.kind === "rateLimited" ? limited() : error;
      }
      limits.observeBody(scope, json.data?.rateLimit);
      if (graphqlRateLimited(json.errors, headers)) throw limited();
      limits.succeeded(scope);
      const error = json.errors?.[0];
      if (error && !json.data) throw new LiveError("other", error.message);
      return json;
    });
  }

  function restSearch(sendRest: GithubRestSend, a: Account, interactive: boolean, kind: SearchKind, consent: ConsentToken | null): Promise<RestResult> {
    const scope = restScope(a.scope);
    return limits.withSlot(async () => {
      if (limits.blockedUntil(scope, interactive) !== null) return "held";
      let headers: HeaderReader | null = null;
      noteLiveGithubRequest("sent", consent);
      try {
        const json = (await sendRest(a.scope, restQuery(GITHUB_SEARCHES[kind]), (h) => {
          headers = h;
          limits.observe(scope, h);
        })) as RestSearch;
        if (!Array.isArray(json?.items)) return "failed";
        const items = restItems(json);
        limits.succeeded(scope);
        return { items, complete: json.incomplete_results !== true };
      } catch (error) {
        if (error instanceof LiveError && error.kind === "rateLimited") {
          noteLiveGithubRequest("rateLimited", consent);
          limits.rateLimited(scope, retryAtFromHeaders(headers, clock()));
        }
        return "failed";
      }
    });
  }

  async function toListed(a: Account, interactive: boolean, searches: Searches, consent: ConsentToken | null): Promise<Listed> {
    const nodes = (res: SearchResponse) => ({ nodes: res.data?.search.nodes ?? [] });
    const json: GithubResponse = { data: { authored: nodes(searches.authored), review: nodes(searches.review), direct: nodes(searches.direct) } };
    const keys = new Map<string, string | null>();
    for (const n of [...json.data!.authored.nodes, ...json.data!.review.nodes]) if (n && "id" in n && n.id && !keys.has(n.id)) keys.set(n.id, changeKey(n as ListedPR));
    const listing = listingOf(json);
    const restItemsById = new Map<string, LiveItem>();
    const blocks = SEARCH_KINDS.map((kind) => ({ kind, errors: blockedNodes(searches[kind].errors) })).filter(({ errors }) => errors.length);
    if (blocks.length) noteLiveGithubBlocked(consent);
    const affected = blocks.filter(({ errors }) => errors.some(isClassicPat));
    if (!rest || !affected.length) return { ...listing, keys, blocked: blockedError(blocks.flatMap(({ errors }) => errors)), rest: restItemsById };

    const sendRest = rest;
    const results = await Promise.all(affected.map(async ({ kind }) => ({ kind, result: await restSearch(sendRest, a, interactive, kind, consent) })));
    const recovered = new Set<SearchKind>();
    let attempted = 0;
    let failed = 0;
    for (const { kind, result } of results) {
      if (result === "held") continue;
      attempted++;
      if (result === "failed") {
        failed++;
        continue;
      }
      const ids = new Set(listing[kind]);
      for (const item of result.items) {
        const id = item.id.slice("github:".length);
        if (ids.has(id)) continue;
        ids.add(id);
        if (kind === "direct") listing.direct.add(id);
        else {
          listing[kind].push(id);
          if (!keys.has(id)) restItemsById.set(id, item);
        }
        if (result.complete && (kind !== "direct" || listing.review.includes(id))) recovered.add(kind);
      }
    }
    if (attempted) noteLiveGithubRest(consent, restItemsById.size, failed);
    const remaining = blocks.flatMap(({ kind, errors }) => recovered.has(kind) ? errors.filter((error) => !isClassicPat(error)) : errors);
    return { ...listing, keys, blocked: blockedError(remaining), rest: restItemsById };
  }

  function applyRest(a: Account, listed: Listed) {
    const at = clock();
    for (const [id, item] of listed.rest) {
      a.pending.delete(id);
      const previous = a.details.get(id);
      if (previous && sameJson(previous.item, item)) a.details.set(id, { ...previous, key: null, at });
      else a.details.set(id, { key: null, at, item, bySection: {}, stacked: null });
    }
  }

  function list(a: Account, interactive: boolean): Promise<Listed> {
    const shared = a.list;
    if (shared && (!shared.done || (!interactive && clock() - shared.at < LIST_SHARED_MS))) return shared.promise;
    const consent = consentToken();
    const search = (query: string, q: string) => graphql<SearchResponse & Reply>(a.scope, interactive, query, { q });
    const searches = Promise.all([search(GITHUB_SEARCH_QUERY, GITHUB_SEARCHES.authored), search(GITHUB_SEARCH_QUERY, GITHUB_SEARCHES.review), search(GITHUB_DIRECT_QUERY, GITHUB_SEARCHES.direct)]);
    const entry = { at: clock(), done: false, promise: searches.then(([authored, review, direct]) => toListed(a, interactive, { authored, review, direct }, consent)) };
    a.list = entry;
    entry.promise.then(
      (listed) => {
        entry.done = true;
        entry.at = clock();
        a.blocked = listed.blocked;
        applyRest(a, listed);
        for (const id of a.details.keys()) if (!listed.keys.has(id) && !listed.rest.has(id)) a.details.delete(id);
      },
      () => {
        if (a.list === entry) a.list = null;
      },
    );
    return entry.promise;
  }

  function readPage(a: Account, interactive: boolean, listed: Listed, ids: string[]): Promise<void> {
    const page = () => graphql<DetailsResponse & Reply>(a.scope, interactive, GITHUB_DETAILS_QUERY, { ids }).then((res) => detailNodes(ids, res));
    const retried = page().catch((error: unknown) => (error instanceof LiveError && (error.kind === "other" || error.kind === "network") ? page() : Promise.reject(error)));
    const done = retried.then((nodes) => {
      const at = clock();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const id of ids) {
        if (a.pending.get(id) !== done) continue;
        const node = byId.get(id);
        const item = node && node.state === "OPEN" ? prItem(node) : null;
        const previous = a.details.get(id);
        const key = listed.keys.get(id) ?? null;
        if (previous && sameJson(previous.item, item)) a.details.set(id, { ...previous, key, at });
        else a.details.set(id, { key, at, item, bySection: {}, stacked: null });
      }
    });
    const settle = () => {
      for (const id of ids) if (a.pending.get(id) === done) a.pending.delete(id);
    };
    done.then(settle, settle);
    for (const id of ids) a.pending.set(id, done);
    return done;
  }

  async function ensureDetails(a: Account, interactive: boolean, listed: Listed, ids: string[]) {
    const now = clock();
    const stale: string[] = [];
    const waits = new Set<Promise<void>>();
    const needed = ids.filter((id) => !listed.rest.has(id));
    let joined = 0;
    for (const id of needed) {
      const detail = a.details.get(id);
      const key = listed.keys.get(id) ?? null;
      if (detail && key !== null && detail.key === key && now - detail.at < (unsettled(detail.item) ? PENDING_FRESH_MS : DETAILS_FRESH_MS)) continue;
      const pending = a.pending.get(id);
      if (pending) (waits.add(pending), joined++);
      else stale.push(id);
    }
    for (let i = 0; i < stale.length; i += DETAILS_PAGE) waits.add(readPage(a, interactive, listed, stale.slice(i, i + DETAILS_PAGE)));
    noteLiveGithubDetails(stale.length, needed.length - stale.length - joined);
    await Promise.all(waits);
  }

  function itemsFor(a: Account, listed: Listed, filters: LiveFolder["filters"]): LiveItem[] {
    const items: LiveItem[] = [];
    for (const { id, section } of sectioned(listed, filters)) {
      const detail = a.details.get(id);
      if (!detail?.item) continue;
      items.push((detail.bySection[section] ??= { ...detail.item, section }));
    }
    const stacked = withStacks(items);
    for (let i = 0; i < stacked.length; i++) {
      const from = items[i]!;
      const out = stacked[i]!;
      if (out === from) continue;
      const detail = a.details.get(from.id.slice("github:".length));
      if (!detail) continue;
      const memo = detail.stacked;
      if (memo && memo.from === from && sameJson(memo.item.pr?.stack, out.pr?.stack)) stacked[i] = memo.item;
      else detail.stacked = { from, item: out };
    }
    return stacked;
  }

  async function fetchFolder(scope: string, folder: LiveFolder, interactive: boolean): Promise<LiveItem[]> {
    const a = account(scope);
    const listed = await list(a, interactive);
    await ensureDetails(a, interactive, listed, sectioned(listed, folder.filters).map((s) => s.id));
    return itemsFor(a, listed, folder.filters);
  }

  async function resolveGone(scope: string, items: LiveItem[], interactive: boolean): Promise<Record<string, CompletionState>> {
    const byId = new Map(items.filter((it) => it.source === "github").map((it) => [it.id.slice("github:".length), it]));
    if (!byId.size) return {};
    const json = await graphql<{ data?: { nodes: ({ id: string; state: string } | null)[] } } & Reply>(scope, interactive, GITHUB_STATE_QUERY, { ids: [...byId.keys()] });
    const out: Record<string, CompletionState> = {};
    for (const n of json.data?.nodes ?? []) {
      const item = n && byId.get(n.id);
      if (!n || !item) continue;
      if (n.state === "MERGED") out[item.id] = "merged";
      else if (n.state === "CLOSED") out[item.id] = "closed";
      else if (item.section === "review" || item.section === "team") out[item.id] = "reviewed";
    }
    return out;
  }

  async function viewer(scope: string) {
    const json = await graphql<{ data?: { viewer: { login: string; name: string | null; avatarUrl: string } } } & Reply>(scope, true, VIEWER_QUERY, {});
    return json.data?.viewer ?? null;
  }

  const pausedUntil = () => (current ? limits.blockedUntil(current.scope, false) : null);
  const warning = () => current?.blocked ?? null;

  return { fetchFolder, resolveGone, viewer, pausedUntil, warning };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
