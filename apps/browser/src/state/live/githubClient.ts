import { blockedError, blockedNodes, changeKey, DETAILS_PAGE, detailNodes, GITHUB_DETAILS_QUERY, GITHUB_DIRECT_QUERY, GITHUB_SEARCH_QUERY, GITHUB_SEARCHES, GITHUB_STATE_QUERY, listingOf, prItem, sectioned, VIEWER_QUERY, withStacks, type DetailsResponse, type GithubResponse, type ListedPR, type Listing, type RateLimitInfo, type SearchResponse } from "./github";
import { createGithubLimits, graphqlRateLimited, retryAtFromHeaders, type GithubLimits, type HeaderReader } from "./githubLimits";
import { LiveError, type CompletionState, type LiveFolder, type LiveItem, type PullRequestSection } from "./types";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteLiveGithubBlocked, noteLiveGithubDetails, noteLiveGithubRequest } from "../telemetry/liveGithub";
import { t } from "../../lib/uiLanguage";


export const LIST_SHARED_MS = 30_000;
export const DETAILS_FRESH_MS = 10 * 60_000;
export const PENDING_FRESH_MS = 60_000;

export type GraphqlPayload = { query: string; variables: Record<string, unknown> };
export type GithubSend = (scope: string, payload: GraphqlPayload, onHeaders: (headers: HeaderReader) => void) => Promise<unknown>;

type Reply = { data?: { rateLimit?: RateLimitInfo | null } | null; errors?: { type?: string; message: string }[] };
type Listed = Listing & { keys: Map<string, string | null>; blocked: LiveError | null };
type Searches = { authored: SearchResponse; review: SearchResponse; direct: SearchResponse };
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

function toListed({ authored, review, direct }: Searches, consent: ConsentToken | null): Listed {
  const nodes = (res: SearchResponse) => ({ nodes: res.data?.search.nodes ?? [] });
  const json: GithubResponse = { data: { authored: nodes(authored), review: nodes(review), direct: nodes(direct) } };
  const keys = new Map<string, string | null>();
  for (const n of [...json.data!.authored.nodes, ...json.data!.review.nodes]) if (n && "id" in n && n.id && !keys.has(n.id)) keys.set(n.id, changeKey(n as ListedPR));
  const blocked = blockedError([authored, review, direct].flatMap((res) => blockedNodes(res.errors)));
  if (blocked) noteLiveGithubBlocked(consent);
  return { ...listingOf(json), keys, blocked };
}

export function createGithubClient(send: GithubSend, clock: () => number = Date.now, limits: GithubLimits = createGithubLimits(clock)) {
  let current: Account | null = null;

  const account = (scope: string): Account => {
    if (current?.scope === scope) return current;
    if (current) limits.forget(current.scope);
    return (current = { scope, list: null, details: new Map(), pending: new Map(), blocked: null });
  };

  async function graphql<T extends Reply>(scope: string, interactive: boolean, query: string, variables: Record<string, unknown>): Promise<T> {
    return limits.withSlot(async () => {
      if (limits.blockedUntil(scope, interactive) !== null) {
        noteLiveGithubRequest("held");
        throw new LiveError("rateLimited", t(`Waiting for the GitHub rate limit to reset`));
      }
      let headers: HeaderReader | null = null;
      const limited = () => {
        noteLiveGithubRequest("rateLimited");
        limits.rateLimited(scope, retryAtFromHeaders(headers, clock()));
        return new LiveError("rateLimited", t(`Rate Limit Exceeded`));
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

  function list(a: Account, interactive: boolean): Promise<Listed> {
    const shared = a.list;
    if (shared && (!shared.done || (!interactive && clock() - shared.at < LIST_SHARED_MS))) return shared.promise;
    const consent = consentToken();
    const search = (query: string, q: string) => graphql<SearchResponse & Reply>(a.scope, interactive, query, { q });
    const searches = Promise.all([search(GITHUB_SEARCH_QUERY, GITHUB_SEARCHES.authored), search(GITHUB_SEARCH_QUERY, GITHUB_SEARCHES.review), search(GITHUB_DIRECT_QUERY, GITHUB_SEARCHES.direct)]);
    const entry = { at: clock(), done: false, promise: searches.then(([authored, review, direct]) => toListed({ authored, review, direct }, consent)) };
    a.list = entry;
    entry.promise.then(
      (listed) => {
        entry.done = true;
        entry.at = clock();
        a.blocked = listed.blocked;
        for (const id of a.details.keys()) if (!listed.keys.has(id)) a.details.delete(id);
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
    let joined = 0;
    for (const id of ids) {
      const detail = a.details.get(id);
      const key = listed.keys.get(id) ?? null;
      if (detail && key !== null && detail.key === key && now - detail.at < (unsettled(detail.item) ? PENDING_FRESH_MS : DETAILS_FRESH_MS)) continue;
      const pending = a.pending.get(id);
      if (pending) (waits.add(pending), joined++);
      else stale.push(id);
    }
    for (let i = 0; i < stale.length; i += DETAILS_PAGE) waits.add(readPage(a, interactive, listed, stale.slice(i, i + DETAILS_PAGE)));
    noteLiveGithubDetails(stale.length, ids.length - stale.length - joined);
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
