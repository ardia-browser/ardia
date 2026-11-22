import { LiveError, type CheckState, type LiveItem, type PullRequestCheck, type PullRequestInfo, type PullRequestSection } from "./types";
import { t } from "../../lib/uiLanguage";


const PR_FIELDS = t(`
  ... on PullRequest {
    id number title url isDraft updatedAt createdAt
    headRefName baseRefName mergeable reviewDecision
    additions deletions changedFiles
    repository { nameWithOwner }
    author { login avatarUrl(size: 64) }
    comments { totalCount }
    reviewThreads(first: 50) { nodes { isResolved } }
    commits(last: 1) {
      nodes { commit { statusCheckRollup { state contexts(first: 60) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } }
    }
  }`);

const CHANGE_FIELDS = t(`id updatedAt headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`);

const RATE_LIMIT = t(`rateLimit { limit remaining resetAt }`);

export const GITHUB_SEARCH_QUERY = `query LiveFolderSearch($q: String!) { ${RATE_LIMIT} search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${CHANGE_FIELDS} } } } }`;

export const GITHUB_DIRECT_QUERY = `query LiveFolderDirect($q: String!) { ${RATE_LIMIT} search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest { id } } } }`;

export const GITHUB_DETAILS_QUERY = `query LiveFolderDetails($ids: [ID!]!) { ${RATE_LIMIT} nodes(ids: $ids) { ${PR_FIELDS} ... on PullRequest { state } } }`;

export const DETAILS_PAGE = 10;

export const GITHUB_SEARCHES = {
  authored: t(`is:pr is:open author:@me archived:false sort:updated-desc`),
  review: t(`is:pr is:open review-requested:@me archived:false sort:updated-desc`),
  direct: t(`is:pr is:open user-review-requested:@me archived:false`),
};

export const GITHUB_STATE_QUERY = t(`query LiveFolderGone($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id state } }
}`);

export const VIEWER_QUERY = t(`query { viewer { login name avatarUrl(size: 64) } }`);

type RawCheck =
  | { __typename: t(`CheckRun`); name: string; status: string; conclusion: string | null; detailsUrl: string | null }
  | { __typename: t(`StatusContext`); context: string; state: string; targetUrl: string | null };

export type RawPR = {
  id: string;
  state?: t(`OPEN`) | t(`CLOSED`) | t(`MERGED`);
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  mergeable: t(`MERGEABLE`) | t(`CONFLICTING`) | t(`UNKNOWN`);
  reviewDecision: t(`APPROVED`) | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  repository: { nameWithOwner: string };
  author: { login: string; avatarUrl: string } | null;
  comments: { totalCount: number };
  reviewThreads?: { nodes: { isResolved: boolean }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: RawCheck[] } } | null } }[] };
};

type StateCount = { state: string; count: number };

export type ListedPR = {
  id: string;
  updatedAt?: string;
  headRefOid?: string;
  mergeable?: string;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

export function changeKey(listed: ListedPR | undefined): string | null {
  if (!listed?.updatedAt) return null;
  return JSON.stringify([listed.updatedAt, listed.headRefOid ?? null, listed.mergeable ?? null, listed.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null]);
}

export type RateLimitInfo = { limit: number; remaining: number; resetAt: string };

type GraphqlError = { type?: string; message: string; path?: (string | number)[] };

type SearchNode = ListedPR | RawPR | { id: string } | Record<string, never> | null;

export type GithubResponse = {
  data?: {
    rateLimit?: RateLimitInfo | null;
    authored: { nodes: SearchNode[] };
    review: { nodes: SearchNode[] };
    direct: { nodes: SearchNode[] };
  };
  errors?: GraphqlError[];
};

export type SearchResponse = { data?: { rateLimit?: RateLimitInfo | null; search: { nodes: SearchNode[] } } | null; errors?: GraphqlError[] };

const ORG_SSO = /SAML|single sign-on/i;

export function blockedNodes(errors: readonly GraphqlError[] | undefined): GraphqlError[] {
  return (errors ?? []).filter((e) => e.type === "FORBIDDEN" && e.path?.[1] === "nodes" && e.path.length === 3);
}

export function blockedError(blocked: readonly GraphqlError[]): LiveError | null {
  if (!blocked.length) return null;
  const sso = blocked.find((e) => ORG_SSO.test(e.message));
  return sso ? new LiveError("sso", sso.message) : new LiveError("tokenBlocked", blocked[0]!.message);
}

export function blockedLink(message: string): string | null {
  return message.match(/https:\/\/github\.com\/(?:settings|orgs)\/[^\st(`')]+/)?.[0]?.replace(/[.,]$/, `)") ?? null;
}

export function checkState(c: RawCheck): CheckState {
  if (c.__typename === "StatusContext") {
    if (c.state === "SUCCESS") return "success";
    if (c.state === "FAILURE" || c.state === "ERROR") return "failure";
    return "pending";
  }
  if (c.status !== "COMPLETED") return c.status === "IN_PROGRESS" ? "pending" : "queued";
  switch (c.conclusion) {
    case t(`SUCCESS`):
      return "success";
    case t(`NEUTRAL`):
    case t(`SKIPPED`):
    case t(`STALE`):
      return "neutral";
    default:
      return "failure";
  }
}

export function prItem(raw: RawPR, section?: PullRequestSection): LiveItem {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
  const checks: PullRequestCheck[] = (rollup?.contexts.nodes ?? []).map((c) => ({
    name: c.__typename === "CheckRun" ? c.name : c.context,
    state: checkState(c),
    url: c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl,
  }));
  const pr: PullRequestInfo = {
    number: raw.number,
    repo: raw.repository.nameWithOwner,
    author: raw.author?.login ?? "ghost",
    authorAvatar: raw.author?.avatarUrl ?? null,
    draft: raw.isDraft,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    review: raw.reviewDecision === "APPROVED" ? "approved" : raw.reviewDecision === "CHANGES_REQUESTED" ? "changesRequested" : raw.reviewDecision === "REVIEW_REQUIRED" ? "required" : null,
    mergeable: raw.mergeable === "CONFLICTING" ? "conflicting" : raw.mergeable === "MERGEABLE" ? "mergeable" : "unknown",
    checks,
    comments: raw.comments.totalCount,
    unresolvedThreads: (raw.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
  };
  return {
    id: `github:${raw.id}`,
    source: "github",
    url: raw.url,
    title: raw.title,
    subtitle: `${raw.repository.nameWithOwner} #${raw.number}`,
    icon: null,
    updatedAt: Date.parse(raw.updatedAt) || 0,
    section,
    pr,
  };
}

const isPR = (n: SearchNode): n is RawPR => !!n && "number" in n;

export type Listing = { authored: string[]; review: string[]; direct: Set<string> };

const idsOf = (nodes: SearchNode[]) => nodes.flatMap((n) => (n && "id" in n && n.id ? [n.id] : []));

export function listingOf(json: GithubResponse): Listing {
  const data = json.data;
  return { authored: idsOf(data?.authored.nodes ?? []), review: idsOf(data?.review.nodes ?? []), direct: new Set(idsOf(data?.direct.nodes ?? [])) };
}

export type Sectioned = { id: string; section: PullRequestSection };

export function sectioned(listing: Listing, filters: { authored: boolean; reviewRequests: boolean }): Sectioned[] {
  const out: Sectioned[] = [];
  const seen = new Set<string>();
  const add = (id: string, section: PullRequestSection) => void (seen.has(id) || (seen.add(id), out.push({ id, section })));
  if (filters.authored) for (const id of listing.authored) add(id, "authored");
  if (filters.reviewRequests) for (const id of listing.review) add(id, listing.direct.has(id) ? "review" : "team");
  return out;
}

export type DetailsResponse = { data?: { rateLimit?: RateLimitInfo | null; nodes?: (RawPR | null)[] } | null; errors?: GraphqlError[] };

export function detailNodes(ids: string[], res: DetailsResponse): RawPR[] {
  const errors = res.errors ?? [];
  const limited = errors.find((e) => e.type === "RATE_LIMITED");
  if (limited) throw new LiveError("rateLimited", limited.message);
  const nodes = res.data?.nodes;
  const fail = (error?: GraphqlError) => new LiveError("other", (error ?? errors[0])?.message ?? t(`Missing pull request details`));
  if (!nodes || nodes.length !== ids.length) throw fail();
  return nodes.filter((node, i): node is RawPR => {
    if (node) return true;
    const error = errors.find((e) => e.path?.[0] === "nodes" && e.path[1] === i);
    if (error?.type === "NOT_FOUND" || error?.type === "FORBIDDEN") return false;
    throw fail(error);
  });
}

export function mapGithub(json: GithubResponse, filters: { authored: boolean; reviewRequests: boolean }): LiveItem[] {
  const data = json.data;
  if (!data) return [];
  const byId = new Map<string, RawPR>();
  for (const n of [...data.authored.nodes, ...data.review.nodes]) if (isPR(n) && !byId.has(n.id)) byId.set(n.id, n);
  return withStacks(sectioned(listingOf(json), filters).flatMap(({ id, section }) => {
    const raw = byId.get(id);
    return raw ? [prItem(raw, section)] : [];
  }));
}

export function withStacks(items: LiveItem[]): LiveItem[] {
  const byHead = new Map<string, LiveItem>();
  for (const it of items) if (it.pr) byHead.set(`${it.pr.repo}:${it.pr.headRef}`, it);
  const parent = (it: LiveItem) => (it.pr ? byHead.get(`${it.pr.repo}:${it.pr.baseRef}`) : undefined);
  const bottomOf = (it: LiveItem) => {
    let cur = it;
    const visited = new Set<string>();
    for (let p = parent(cur); p && !visited.has(p.id); p = parent(cur)) {
      visited.add(cur.id);
      cur = p;
    }
    return cur;
  };
  const stacks = new Map<string, LiveItem[]>();
  for (const it of items) {
    if (!it.pr) continue;
    const bottom = bottomOf(it);
    stacks.set(bottom.id, [...(stacks.get(bottom.id) ?? []), it]);
  }
  const info = new Map<string, PullRequestInfo["stack"]>();
  for (const [bottomId, members] of stacks) {
    if (members.length < 2) continue;
    const depth = (it: LiveItem) => {
      let d = 1;
      for (let p = parent(it); p && d <= members.length; p = parent(p)) d++;
      return d;
    };
    const ordered = [...members].sort((a, b) => depth(a) - depth(b) || a.pr!.number - b.pr!.number);
    ordered.forEach((it, i) => info.set(it.id, { id: `stack:${bottomId}`, position: i + 1, size: ordered.length }));
  }
  return items.map((it) => (info.has(it.id) && it.pr ? { ...it, pr: { ...it.pr, stack: info.get(it.id) } } : it));
}

export type CheckSummary = {
  text: string;
  tone: "success" | "failure" | "pending" | "neutral";
  counts: { success: number; failure: number; pending: number };
};

export function summarizeChecks(checks: PullRequestCheck[]): CheckSummary | null {
  if (!checks.length) return null;
  const failure = checks.filter((c) => c.state === "failure").length;
  const pending = checks.filter((c) => c.state === "pending" || c.state === "queued").length;
  const queued = checks.filter((c) => c.state === "queued").length;
  const success = checks.length - failure - pending;
  const counts = { success, failure, pending };
  if (failure) return { text: failure === 1 ? t(`1 check is failing`) : `${failure} checks are failing`, tone: "failure", counts };
  if (queued && queued === pending && !checks.some((c) => c.state === "success")) return { text: t(`Checks are queued`), tone: "pending", counts };
  if (pending) return { text: t(`Some checks haven't completed yet`), tone: "pending", counts };
  return { text: t(`All checks have passed`), tone: "success", counts };
}

export function prBadge(pr: PullRequestInfo): "conflict" | "failing" | "changesRequested" | "pending" | "approved" | "passed" | null {
  if (pr.mergeable === "conflicting") return "conflict";
  const summary = summarizeChecks(pr.checks);
  if (summary?.tone === "failure") return "failing";
  if (pr.review === "changesRequested") return "changesRequested";
  if (summary?.tone === "pending") return "pending";
  if (pr.review === "approved") return "approved";
  if (summary?.tone === "success") return "passed";
  return null;
}
