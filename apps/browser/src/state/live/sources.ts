import { CONFLUENCE_CQL, DRIVE_QUERY, mapBitbucket, mapConfluence, mapDrive, mapNotion, NOTION_SEARCH_BODY, type BitbucketPR, type BitbucketStatuses, type ConfluenceSearch, type DriveFiles, type NotionSearch, type NotionUsers } from "./documents";
import { createGithubClient } from "./githubClient";
import { asSecret, sameSecret } from "@ardia/core";
import { basic, bearer, deleteSecret, endpoints, form, getSecret, googleTokensOf, request, setSecret as keychainSaveToken, storedGoogleTokens, type GoogleTokens, type LiveToken } from "./net";
import { live, setAccount, updateConfig } from "./store";
import { LiveError, PartialFetch, type CompletionState, type LiveAccount, type LiveFolder, type LiveItem, type LiveSourceId } from "./types";
import { symbolIcon } from "../../lib/customIcon";

export type LiveSource = {
  id: LiveSourceId;
  name: string;
  kind: LiveFolder["kind"];
  site: string;
  fetch(folder: LiveFolder, options?: FetchOptions): Promise<LiveItem[]>;
  resolveGone?(items: LiveItem[], options?: FetchOptions): Promise<Record<string, CompletionState>>;
  pausedUntil?(): number | null;
  warning?(): LiveError | null;
};

type FetchOptions = { interactive?: boolean };

async function secret(source: LiveSourceId): Promise<LiveToken> {
  const value = await getSecret(source);
  if (!value) throw new LiveError(live().accounts[source] ? "signedOut" : "notConfigured", "Not signed in");
  return value;
}

type GithubAccount = { scope: string; token: LiveToken; busy: number };

const githubAccounts = new Map<string, GithubAccount>();
let githubAccountCount = 0;
let githubGeneration = 0;
let keptGithub: { scope: string; generation: number } | null = null;

function releaseGithubAccounts() {
  if (keptGithub && keptGithub.generation !== githubGeneration) keptGithub = null;
  for (const [scope, account] of githubAccounts) if (!account.busy && scope !== keptGithub?.scope) githubAccounts.delete(scope);
}

function forgetGithubAccounts() {
  githubGeneration++;
  releaseGithubAccounts();
}

async function withStoredGithubAccount<T>(run: (scope: string) => Promise<T>): Promise<T> {
  const generation = githubGeneration;
  const token = await secret("github");
  if (generation !== githubGeneration) throw new LiveError("signedOut", "Not signed in");
  return withGithubAccount(token, generation, run);
}

async function withGithubAccount<T>(token: LiveToken, storedGeneration: number | null, run: (scope: string) => Promise<T>): Promise<T> {
  let account = [...githubAccounts.values()].find((a) => sameSecret(a.token, token));
  if (!account) {
    account = { scope: `github-account-${++githubAccountCount}`, token, busy: 0 };
    githubAccounts.set(account.scope, account);
  }
  if (storedGeneration === githubGeneration) keptGithub = { scope: account.scope, generation: storedGeneration };
  account.busy++;
  try {
    return await run(account.scope);
  } finally {
    account.busy--;
    releaseGithubAccounts();
  }
}

async function setSecret(source: LiveSourceId, token: LiveToken) {
  if ((await keychainSaveToken(source, token)) === false) throw new LiveError("other", "The Keychain didn't save the sign-in");
}

function githubToken(scope: string): LiveToken {
  const token = githubAccounts.get(scope)?.token;
  if (!token) throw new LiveError("signedOut", "Not signed in");
  return token;
}

export const githubAccountsHeld = () => githubAccounts.size;

const githubClient = createGithubClient((scope, payload, onHeaders) =>
  request(endpoints.githubGraphql, { method: "POST", headers: { Authorization: bearer(githubToken(scope)), "Content-Type": "application/json" }, body: JSON.stringify(payload) }, onHeaders),
);

const github: LiveSource = {
  id: "github",
  name: "GitHub",
  kind: "pullRequests",
  site: "https://github.com",
  async fetch(folder, options) {
    return withStoredGithubAccount((scope) => githubClient.fetchFolder(scope, folder, !!options?.interactive));
  },
  async resolveGone(items, options) {
    if (!items.some((it) => it.source === "github")) return {};
    return withStoredGithubAccount((scope) => githubClient.resolveGone(scope, items, !!options?.interactive));
  },
  pausedUntil: () => githubClient.pausedUntil(),
  warning: () => githubClient.warning(),
};

const BITBUCKET_BATCH = 10;

async function inBitbucketBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += BITBUCKET_BATCH) results.push(...(await Promise.allSettled(items.slice(i, i + BITBUCKET_BATCH).map(run))));
  return results;
}

const fulfilled = <R>(results: PromiseSettledResult<R>[]) => results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

const BITBUCKET_STATUS_REUSE_MS = 15 * 60_000;

const bitbucketStatusCache = new Map<string, { commit: string; at: number; statuses: BitbucketStatuses }>();

const bitbucketStatusKey = (pr: BitbucketPR) => `${pr.destination.repository.full_name}#${pr.id}`;

async function bitbucketStatuses(pr: BitbucketPR, auth: string, now: number): Promise<BitbucketStatuses | null> {
  const key = bitbucketStatusKey(pr);
  const commit = pr.source.commit?.hash;
  const cached = bitbucketStatusCache.get(key);
  const running = cached?.statuses.values.some((status) => status.state === "INPROGRESS");
  if (commit && cached?.commit === commit && !running && now - cached.at < BITBUCKET_STATUS_REUSE_MS) return cached.statuses;
  const statuses = await request<BitbucketStatuses>(`${endpoints.bitbucket}/repositories/${pr.destination.repository.full_name}/pullrequests/${pr.id}/statuses?pagelen=50`, {
    headers: { Authorization: auth },
  }).catch(() => null);
  if (statuses && commit) bitbucketStatusCache.set(key, { commit, at: now, statuses });
  return statuses;
}

const bitbucketAuth = async () => basic(live().config.bitbucketUser, await secret("bitbucket"));

async function bitbucketPages<T>(url: string, auth: string): Promise<T[]> {
  const values: T[] = [];
  const visited = new Set<string>();
  for (let next: string | undefined = url; next; ) {
    if (visited.has(next)) throw new LiveError("other", `Bitbucket returned the same page twice: ${next}`);
    visited.add(next);
    const page: { values: T[]; next?: string } = await request(next, { headers: { Authorization: auth } });
    values.push(...page.values);
    next = page.next;
  }
  return values;
}

const bitbucket: LiveSource = {
  id: "bitbucket",
  name: "Bitbucket",
  kind: "pullRequests",
  site: "https://bitbucket.org",
  async fetch(folder) {
    if (!folder.filters.authored) return [];
    const auth = await bitbucketAuth();
    const me = live().accounts.bitbucket;
    if (!me) throw new LiveError("signedOut", "Not signed in");
    const workspaces = await bitbucketPages<{ workspace: { slug: string } }>(`${endpoints.bitbucket}/user/workspaces?pagelen=100`, auth);
    const results = await inBitbucketBatches(workspaces, ({ workspace }) =>
      bitbucketPages<BitbucketPR>(`${endpoints.bitbucket}/workspaces/${encodeURIComponent(workspace.slug)}/pullrequests/${encodeURIComponent(me.login)}?state=OPEN&pagelen=50`, auth),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length && failures.length === results.length) throw failures[0];
    const failedWorkspaces = new Set(workspaces.filter((_, i) => results[i]?.status === "rejected").map(({ workspace }) => workspace.slug));
    const keptFromFailedWorkspaces = (live().items[folder.id] ?? []).filter((it) => it.source === "bitbucket" && it.pr && failedWorkspaces.has(it.pr.repo.split("/")[0] ?? ""));
    const prs = fulfilled(results).flat();
    const now = Date.now();
    const items = await inBitbucketBatches(prs, async (pr) => mapBitbucket(pr, await bitbucketStatuses(pr, auth, now)));
    if (!failedWorkspaces.size) {
      const open = new Set(prs.map(bitbucketStatusKey));
      for (const key of bitbucketStatusCache.keys()) if (!open.has(key)) bitbucketStatusCache.delete(key);
    }
    const itemFailure = items.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (itemFailure) throw itemFailure.reason;
    const listed = [...fulfilled(items), ...keptFromFailedWorkspaces];
    if (failures.length) throw new PartialFetch(listed, failures);
    return listed;
  },
  async resolveGone(items) {
    const auth = await bitbucketAuth();
    const out: Record<string, CompletionState> = {};
    const prs = items.flatMap((it) => (it.pr ? [{ id: it.id, repo: it.pr.repo, number: it.pr.number }] : []));
    await inBitbucketBatches(prs, async ({ id, repo, number }) => {
      const pr = await request<{ state: string }>(`${endpoints.bitbucket}/repositories/${repo}/pullrequests/${number}`, { headers: { Authorization: auth } }).catch(() => null);
      if (pr?.state === "MERGED") out[id] = "merged";
      else if (pr?.state === "DECLINED" || pr?.state === "SUPERSEDED") out[id] = "closed";
    });
    return out;
  },
};

const notionHeaders = (token: LiveToken) => ({ Authorization: bearer(token), "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

const notion: LiveSource = {
  id: "notion",
  name: "Notion",
  kind: "documents",
  site: "https://www.notion.so",
  async fetch() {
    const token = await secret("notion");
    const [pages, users] = await Promise.all([
      request<NotionSearch>(`${endpoints.notion}/search`, { method: "POST", headers: notionHeaders(token), body: JSON.stringify(NOTION_SEARCH_BODY) }),
      request<NotionUsers>(`${endpoints.notion}/users?page_size=100`, { headers: notionHeaders(token) }).catch(() => null),
    ]);
    return mapNotion(pages, users, live().accounts.notion?.name ?? null);
  },
};

const confluence: LiveSource = {
  id: "confluence",
  name: "Confluence",
  kind: "documents",
  site: "https://www.atlassian.com",
  async fetch() {
    const { confluenceSite, confluenceEmail } = live().config;
    if (!confluenceSite) throw new LiveError("notConfigured", "No Confluence site");
    const auth = basic(confluenceEmail, await secret("confluence"));
    const url = `${endpoints.confluence(confluenceSite)}/wiki/rest/api/content/search?limit=30&expand=space,history.lastUpdated&cql=${encodeURIComponent(CONFLUENCE_CQL)}`;
    return mapConfluence(await request<ConfluenceSearch>(url, { headers: { Authorization: auth } }), confluenceSite);
  },
};

async function googleAccessToken(): Promise<LiveToken> {
  const stored = googleTokensOf(await secret("gdrive"));
  if (stored.expires_at > Date.now() + 60_000) return stored.access_token;
  const json = await request<{ access_token: string; expires_in: number }>(endpoints.googleToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: live().config.googleClientId, client_secret: stored.client_secret, refresh_token: stored.refresh_token, grant_type: "refresh_token" }),
  });
  const access = asSecret("oauthToken", json.access_token);
  await keychainSaveToken("gdrive", storedGoogleTokens({ ...stored, access_token: access, expires_at: Date.now() + json.expires_in * 1000 }));
  return access;
}

const gdrive: LiveSource = {
  id: "gdrive",
  name: "Google Drive",
  kind: "documents",
  site: "https://drive.google.com",
  async fetch() {
    const token = await googleAccessToken();
    const query = Object.entries(DRIVE_QUERY)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return mapDrive(await request<DriveFiles>(`${endpoints.drive}/files?${query}`, { headers: { Authorization: bearer(token) } }));
  },
};

export const SOURCES: Record<LiveSourceId, LiveSource> = { github, bitbucket, notion, confluence, gdrive };

const account = (login: string, name: string | null, avatar: string | null): LiveAccount => ({ login, name, avatar, connectedAt: Date.now() });

export async function connectGithub(typed: string) {
  const token = asSecret("oauthToken", typed.trim());
  const viewer = await withGithubAccount(token, null, (scope) => githubClient.viewer(scope));
  if (!viewer) throw new LiveError("signedOut", "GitHub didn't accept the token");
  await setSecret("github", token);
  forgetGithubAccounts();
  setAccount("github", account(viewer.login, viewer.name, viewer.avatarUrl));
}

export type DeviceFlow = { userCode: string; verificationUri: string; expiresAt: number; done: Promise<void>; cancel(): void };

export async function startGithubDeviceFlow(clientId: string): Promise<DeviceFlow> {
  const code = await request<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
    `${endpoints.githubWeb}/login/device/code`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: clientId, scope: "repo read:org" }) },
  );
  const deviceCode = asSecret("oauthToken", code.device_code);
  let cancelled = false;
  let interval = Math.max(code.interval, 1) * 1000;
  const expiresAt = Date.now() + code.expires_in * 1000;
  const done = (async () => {
    while (!cancelled && Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) break;
      const json = await request<{ access_token?: string; error?: string; interval?: number }>(`${endpoints.githubWeb}/login/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      if (json.access_token) return connectGithub(json.access_token);
      if (json.error === "slow_down") interval = (json.interval ?? interval / 1000 + 5) * 1000;
      else if (json.error && json.error !== "authorization_pending") throw new LiveError("signedOut", json.error === "access_denied" ? "Access was denied" : "GitHub didn't finish signing in");
    }
    throw new LiveError("signedOut", cancelled ? "Cancelled" : "The code expired");
  })();
  return { userCode: code.user_code, verificationUri: code.verification_uri, expiresAt, done, cancel: () => (cancelled = true) };
}

export async function connectBitbucket(user: string, typed: string) {
  const token = asSecret("apiToken", typed.trim());
  const me = await request<{ account_id: string; display_name: string; links?: { avatar?: { href: string } } }>(`${endpoints.bitbucket}/user`, {
    headers: { Authorization: basic(user.trim(), token) },
  });
  await setSecret("bitbucket", token);
  updateConfig({ bitbucketUser: user.trim() });
  setAccount("bitbucket", account(me.account_id, me.display_name, me.links?.avatar?.href ?? null));
}

export async function connectNotion(typed: string) {
  const token = asSecret("apiToken", typed.trim());
  const me = await request<{ name?: string; bot?: { workspace_name?: string } }>(`${endpoints.notion}/users/me`, { headers: notionHeaders(token) });
  await setSecret("notion", token);
  setAccount("notion", account(me.bot?.workspace_name ?? me.name ?? "Notion", me.bot?.workspace_name ?? null, null));
}

export async function connectConfluence(site: string, email: string, typed: string) {
  const token = asSecret("apiToken", typed.trim());
  const base = site.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
  const me = await request<{ accountId: string; displayName: string }>(`${endpoints.confluence(base)}/wiki/rest/api/user/current`, {
    headers: { Authorization: basic(email.trim(), token) },
  });
  await setSecret("confluence", token);
  updateConfig({ confluenceSite: base, confluenceEmail: email.trim() });
  setAccount("confluence", account(me.accountId, me.displayName, null));
}

export async function connectGoogle(clientId: string, typedClientSecret: string, code: LiveToken, verifier: LiveToken, redirectUri: string) {
  const clientSecret = asSecret("oauthClientSecret", typedClientSecret);
  const json = await request<{ access_token: string; refresh_token?: string; expires_in: number }>(endpoints.googleToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  if (!json.refresh_token) throw new LiveError("signedOut", "Google didn't return a refresh token");
  const tokens: GoogleTokens = { access_token: asSecret("oauthToken", json.access_token), refresh_token: asSecret("oauthToken", json.refresh_token), expires_at: Date.now() + json.expires_in * 1000, client_secret: clientSecret };
  await setSecret("gdrive", storedGoogleTokens(tokens));
  const about = await request<{ user?: { displayName: string; emailAddress: string; photoLink?: string } }>(`${endpoints.drive}/about?fields=user`, {
    headers: { Authorization: bearer(tokens.access_token) },
  }).catch(() => null);
  updateConfig({ googleClientId: clientId });
  setAccount("gdrive", account(about?.user?.emailAddress ?? "Google Drive", about?.user?.displayName ?? null, about?.user?.photoLink ?? null));
}

export async function disconnect(source: LiveSourceId): Promise<boolean> {
  if (source === "github") forgetGithubAccounts();
  if ((await deleteSecret(source)) === false) return false;
  setAccount(source, null);
  return true;
}

export function liveFolderIcon(folder: LiveFolder): { site: string; icon: string | null } {
  return { site: SOURCES[folder.sources[0] ?? "github"].site, icon: folder.icon ?? (folder.sources.length > 1 && folder.kind === "documents" ? symbolIcon("doc.text") : null) };
}
