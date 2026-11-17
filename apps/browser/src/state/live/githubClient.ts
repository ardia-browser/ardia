import { changeKey, DETAILS_PAGE, detailIds, detailNodes, GITHUB_DETAILS_QUERY, GITHUB_QUERY, GITHUB_STATE_QUERY, GITHUB_VARIABLES, listedById, mapGithub, VIEWER_QUERY, withDetails, type DetailsResponse, type GithubResponse, type RawPR } from "./github";
import { createGithubLimits, graphqlRateLimited, retryAtFromHeaders, type HeaderReader } from "./githubLimits";
import { endpoints, request } from "./net";
import { LiveError, type CompletionState, type LiveFolder, type LiveItem } from "./types";
import { noteLiveGithubDetails, noteLiveGithubRequest } from "../telemetry/liveGithub";

export const LIST_SHARED_MS = 30_000;
export const DETAILS_FRESH_MS = 10 * 60_000;

type GraphqlErrors = { errors?: { type?: string; message: string }[] };
type Cached = { key: string | null; node: RawPR | null; at: number };
type Account = {
  list: { at: number; done: boolean; promise: Promise<GithubResponse> } | null;
  details: Map<string, Cached>;
  pending: Map<string, Promise<RawPR | null>>;
};

export function createGithubClient(clock: () => number = Date.now, limits = createGithubLimits(clock)) {
  const accounts = new Map<string, Account>();
  let lastToken: string | null = null;

  const account = (token: string) => {
    let a = accounts.get(token);
    if (!a) accounts.set(token, (a = { list: null, details: new Map(), pending: new Map() }));
    return a;
  };

  async function graphql<T extends GraphqlErrors>(token: string, interactive: boolean, query: string, variables: Record<string, unknown>): Promise<T> {
    lastToken = token;
    return limits.withSlot(async () => {
      if (limits.blockedUntil(token, interactive) !== null) {
        noteLiveGithubRequest("held");
        throw new LiveError("rateLimited", "Waiting for the GitHub rate limit to reset");
      }
      let headers: HeaderReader | null = null;
      const limited = () => {
        noteLiveGithubRequest("rateLimited");
        limits.rateLimited(token, retryAtFromHeaders(headers, clock()));
        return new LiveError("rateLimited", "Rate Limit Exceeded");
      };
      let json: T;
      try {
        json = await request<T>(
          endpoints.githubGraphql,
          { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) },
          (h) => {
            headers = h;
            noteLiveGithubRequest("sent");
            limits.observe(token, h);
          },
        );
      } catch (error) {
        throw error instanceof LiveError && error.kind === "rateLimited" ? limited() : error;
      }
      if (graphqlRateLimited(json.errors, headers)) throw limited();
      limits.succeeded(token);
      const error = json.errors?.[0];
      if (error && !(json as { data?: unknown }).data) throw new LiveError("other", error.message);
      return json;
    });
  }

  function list(token: string, interactive: boolean): Promise<GithubResponse> {
    const a = account(token);
    const shared = a.list;
    if (shared && (!shared.done || (!interactive && clock() - shared.at < LIST_SHARED_MS))) return shared.promise;
    const entry = { at: clock(), done: false, promise: graphql<GithubResponse>(token, interactive, GITHUB_QUERY, GITHUB_VARIABLES) };
    a.list = entry;
    entry.promise.then(
      () => {
        entry.done = true;
        entry.at = clock();
      },
      () => {
        if (a.list === entry) a.list = null;
      },
    );
    return entry.promise;
  }

  async function details(token: string, interactive: boolean, json: GithubResponse, ids: string[]): Promise<RawPR[]> {
    const a = account(token);
    const listed = listedById(json);
    const now = clock();
    const stale = ids.filter((id) => {
      const cached = a.details.get(id);
      const key = changeKey(listed.get(id));
      return !cached || key === null || cached.key !== key || now - cached.at >= DETAILS_FRESH_MS;
    });
    const toFetch = stale.filter((id) => !a.pending.has(id));
    const page = async (ids: string[]) => detailNodes(ids, await graphql<DetailsResponse>(token, interactive, GITHUB_DETAILS_QUERY, { ids }));
    const retry = (ids: string[]) => (error: unknown) => (error instanceof LiveError && (error.kind === "other" || error.kind === "network") ? page(ids) : Promise.reject(error));
    for (let i = 0; i < toFetch.length; i += DETAILS_PAGE) {
      const ids = toFetch.slice(i, i + DETAILS_PAGE);
      const fetched = page(ids)
        .catch(retry(ids))
        .then((nodes) => {
          const byId = new Map(nodes.map((n) => [n.id, n]));
          const at = clock();
          for (const id of ids) a.details.set(id, { key: changeKey(listed.get(id)), node: byId.get(id) ?? null, at });
          return byId;
        });
      for (const id of ids) {
        const one = fetched.then((byId) => byId.get(id) ?? null);
        const settle = () => void (a.pending.get(id) === one && a.pending.delete(id));
        one.then(settle, settle);
        a.pending.set(id, one);
      }
    }
    const waited = await Promise.all(stale.map((id) => a.pending.get(id) ?? Promise.resolve(a.details.get(id)?.node ?? null)));
    noteLiveGithubDetails(toFetch.length, ids.length - stale.length);
    const fresh = new Map(stale.map((id, i) => [id, waited[i]]));
    for (const id of a.details.keys()) if (!listed.has(id)) a.details.delete(id);
    return ids.flatMap((id) => {
      const node = fresh.has(id) ? fresh.get(id) : a.details.get(id)?.node;
      return node ? [node] : [];
    });
  }

  async function fetchFolder(token: string, folder: LiveFolder, interactive: boolean): Promise<LiveItem[]> {
    const json = await list(token, interactive);
    const nodes = await details(token, interactive, json, detailIds(json, folder.filters));
    return mapGithub(withDetails(json, nodes), folder.filters);
  }

  async function resolveGone(token: string, items: LiveItem[], interactive: boolean): Promise<Record<string, CompletionState>> {
    const prs = items.filter((it) => it.source === "github");
    if (!prs.length) return {};
    const ids = prs.map((it) => it.id.slice("github:".length));
    const json = await graphql<{ data?: { nodes: ({ id: string; state: string } | null)[] } } & GraphqlErrors>(token, interactive, GITHUB_STATE_QUERY, { ids });
    const out: Record<string, CompletionState> = {};
    for (const n of json.data?.nodes ?? []) {
      if (!n) continue;
      const item = prs.find((it) => it.id === `github:${n.id}`);
      if (!item) continue;
      if (n.state === "MERGED") out[item.id] = "merged";
      else if (n.state === "CLOSED") out[item.id] = "closed";
      else if (item.section === "review" || item.section === "team") out[item.id] = "reviewed";
    }
    return out;
  }

  const pausedUntil = () => (lastToken ? limits.blockedUntil(lastToken, false) : null);

  async function viewer(token: string) {
    const json = await graphql<{ data?: { viewer: { login: string; name: string | null; avatarUrl: string } } } & GraphqlErrors>(token, true, VIEWER_QUERY, {});
    return json.data?.viewer ?? null;
  }

  return { fetchFolder, resolveGone, pausedUntil, viewer };
}

export const githubClient = createGithubClient();
