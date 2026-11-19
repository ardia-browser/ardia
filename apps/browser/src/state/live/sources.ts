import { CONFLUENCE_CQL, DRIVE_QUERY, mapBitbucket, mapConfluence, mapDrive, mapNotion, NOTION_SEARCH_BODY, type BitbucketPR, type BitbucketStatuses, type ConfluenceSearch, type DriveFiles, type NotionSearch, type NotionUsers } from "./documents";
import { createGithubClient } from "./githubClient";
import { basic, deleteSecret, endpoints, form, getSecret, request, setSecret } from "./net";
import { useBrowser } from "../browser/store";
import { accountOf, live, removeProfileAccounts, saveLiveDurably, setAccount, setLegacyAccount } from "./store";
import { LiveError, type CompletionState, type LiveAccount, type LiveFolder, type LiveItem, type LiveSourceId } from "./types";
import { noteLiveFolders } from "../telemetry/liveFolders";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";

export type LiveSource = {
  id: LiveSourceId;
  name: string;
  kind: LiveFolder["kind"];
  site: string;
  fetch(folder: LiveFolder, options?: FetchOptions): Promise<LiveItem[]>;
  resolveGone?(folder: LiveFolder, items: LiveItem[], options?: FetchOptions): Promise<Record<string, CompletionState>>;
  pausedUntil?(): number | null;
};

export type FetchOptions = { interactive?: boolean };

async function secret(source: LiveSourceId, profileId: string): Promise<string> {
  const value = await getSecret(source, profileId);
  if (!value) throw new LiveError(accountOf(profileId, source) ? "signedOut" : "notConfigured", "Not signed in");
  return value;
}

const githubClient = createGithubClient((token, payload, onHeaders) =>
  request(endpoints.githubGraphql, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }, onHeaders),
);

function connected(source: LiveSourceId, profileId: string): LiveAccount {
  const account = accountOf(profileId, source);
  if (!account) throw new LiveError("notConfigured", "Not signed in");
  return account;
}

const github: LiveSource = {
  id: "github",
  name: "GitHub",
  kind: "pullRequests",
  site: "https://github.com",
  async fetch(folder, options) {
    return githubClient.fetchFolder(await secret("github", folder.profileId), folder, !!options?.interactive);
  },
  async resolveGone(folder, items, options) {
    if (!items.some((it) => it.source === "github")) return {};
    return githubClient.resolveGone(await secret("github", folder.profileId), items, !!options?.interactive);
  },
  pausedUntil: () => githubClient.pausedUntil(),
};

const BITBUCKET_STATE_BATCH = 10;

const bitbucketAuth = async (profileId: string) => basic(connected("bitbucket", profileId).user ?? "", await secret("bitbucket", profileId));

const bitbucket: LiveSource = {
  id: "bitbucket",
  name: "Bitbucket",
  kind: "pullRequests",
  site: "https://bitbucket.org",
  async fetch(folder) {
    if (!folder.filters.authored) return [];
    const auth = await bitbucketAuth(folder.profileId);
    const me = connected("bitbucket", folder.profileId);
    const page = await request<{ values: BitbucketPR[] }>(`${endpoints.bitbucket}/pullrequests/${encodeURIComponent(me.login)}?state=OPEN&pagelen=50`, {
      headers: { Authorization: auth },
    });
    return Promise.all(
      page.values.map(async (pr) => {
        const repo = pr.destination.repository.full_name;
        const statuses = await request<BitbucketStatuses>(`${endpoints.bitbucket}/repositories/${repo}/pullrequests/${pr.id}/statuses?pagelen=50`, {
          headers: { Authorization: auth },
        }).catch(() => null);
        return mapBitbucket(pr, statuses);
      }),
    );
  },
  async resolveGone(folder, items) {
    const auth = await bitbucketAuth(folder.profileId);
    const out: Record<string, CompletionState> = {};
    const prs = items.flatMap((it) => (it.pr ? [{ id: it.id, repo: it.pr.repo, number: it.pr.number }] : []));
    for (let i = 0; i < prs.length; i += BITBUCKET_STATE_BATCH) {
      await Promise.all(
        prs.slice(i, i + BITBUCKET_STATE_BATCH).map(async ({ id, repo, number }) => {
          const pr = await request<{ state: string }>(`${endpoints.bitbucket}/repositories/${repo}/pullrequests/${number}`, { headers: { Authorization: auth } }).catch(() => null);
          if (pr?.state === "MERGED") out[id] = "merged";
          else if (pr?.state === "DECLINED" || pr?.state === "SUPERSEDED") out[id] = "closed";
        }),
      );
    }
    return out;
  },
};

const notionHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

const notion: LiveSource = {
  id: "notion",
  name: "Notion",
  kind: "documents",
  site: "https://www.notion.so",
  async fetch(folder) {
    const token = await secret("notion", folder.profileId);
    const [pages, users] = await Promise.all([
      request<NotionSearch>(`${endpoints.notion}/search`, { method: "POST", headers: notionHeaders(token), body: JSON.stringify(NOTION_SEARCH_BODY) }),
      request<NotionUsers>(`${endpoints.notion}/users?page_size=100`, { headers: notionHeaders(token) }).catch(() => null),
    ]);
    return mapNotion(pages, users, accountOf(folder.profileId, "notion")?.name ?? null);
  },
};

const confluence: LiveSource = {
  id: "confluence",
  name: "Confluence",
  kind: "documents",
  site: "https://www.atlassian.com",
  async fetch(folder) {
    const { site: confluenceSite, user: confluenceEmail } = connected("confluence", folder.profileId);
    if (!confluenceSite) throw new LiveError("notConfigured", "No Confluence site");
    const auth = basic(confluenceEmail ?? "", await secret("confluence", folder.profileId));
    const url = `${endpoints.confluence(confluenceSite)}/wiki/rest/api/content/search?limit=30&expand=space,history.lastUpdated&cql=${encodeURIComponent(CONFLUENCE_CQL)}`;
    return mapConfluence(await request<ConfluenceSearch>(url, { headers: { Authorization: auth } }), confluenceSite);
  },
};

type GoogleTokens = { access_token: string; refresh_token: string; expires_at: number; client_secret: string; client_id?: string };

async function googleAccessToken(profileId: string): Promise<string> {
  const raw = await secret("gdrive", profileId);
  const stored = JSON.parse(raw) as GoogleTokens;
  if (stored.expires_at > Date.now() + 60_000) return stored.access_token;
  const json = await request<{ access_token: string; expires_in: number }>(endpoints.googleToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: stored.client_id ?? accountOf(profileId, "gdrive")?.clientId ?? live().config.googleClientId, client_secret: stored.client_secret, refresh_token: stored.refresh_token, grant_type: "refresh_token" }),
  });
  const refreshed = JSON.stringify({ ...stored, access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 });
  const kept = await locked("gdrive", profileId, async () => {
    if (!profileExists(profileId) || !accountOf(profileId, "gdrive")) throw new LiveError("notConfigured", "Not signed in");
    if ((await getSecret("gdrive", profileId)) !== raw) return false;
    await setSecret("gdrive", profileId, refreshed);
    return true;
  });
  return kept ? json.access_token : googleAccessToken(profileId);
}

const gdrive: LiveSource = {
  id: "gdrive",
  name: "Google Drive",
  kind: "documents",
  site: "https://drive.google.com",
  async fetch(folder) {
    const token = await googleAccessToken(folder.profileId);
    const query = Object.entries(DRIVE_QUERY)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return mapDrive(await request<DriveFiles>(`${endpoints.drive}/files?${query}`, { headers: { Authorization: `Bearer ${token}` } }));
  },
};

export const SOURCES: Record<LiveSourceId, LiveSource> = { github, bitbucket, notion, confluence, gdrive };

const account = (login: string, name: string | null, avatar: string | null): LiveAccount => ({ login, name, avatar, connectedAt: Date.now() });

const profileExists = (profileId: string) => !!useBrowser.getState().profiles[profileId];

let adoption: Promise<void> = Promise.resolve();

const connectionQueues = new Map<string, Promise<unknown>>();

function locked<T>(source: LiveSourceId, profileId: string, work: () => Promise<T>): Promise<T> {
  const key = `${source}:${profileId}`;
  const result = (connectionQueues.get(key) ?? Promise.resolve()).then(work);
  const settled = result.catch(() => {});
  connectionQueues.set(key, settled);
  void settled.then(() => connectionQueues.get(key) === settled && connectionQueues.delete(key));
  return result;
}

function saveConnection(profileId: string, source: LiveSourceId, value: string, connected: LiveAccount, consent: ConsentToken | null) {
  return locked(source, profileId, async () => {
    if (!profileExists(profileId)) throw new LiveError("other", "This profile was deleted");
    if (!(await setSecret(source, profileId, value))) throw new LiveError("other", "Couldn't save to the keychain");
    if (!profileExists(profileId)) return void (await deleteSecret(source, profileId));
    const elsewhere = Object.entries(live().accounts).some(([id, accounts]) => id !== profileId && !!accounts[source]);
    setAccount(profileId, source, connected);
    noteLiveFolders("live_account_connects", 1, consent);
    if (elsewhere) noteLiveFolders("live_account_connects_beside_another_profile", 1, consent);
    await saveLiveDurably().catch(() => {});
  });
}

export function connectGithub(profileId: string, token: string) {
  return connectGithubWith(profileId, token, consentToken());
}

async function connectGithubWith(profileId: string, token: string, consent: ConsentToken | null) {
  const viewer = await githubClient.viewer(token.trim());
  if (!viewer) throw new LiveError("signedOut", "GitHub didn't accept the token");
  await saveConnection(profileId, "github", token.trim(), account(viewer.login, viewer.name, viewer.avatarUrl), consent);
}

export type DeviceFlow = { userCode: string; verificationUri: string; expiresAt: number; done: Promise<void>; cancel(): void };

export async function startGithubDeviceFlow(profileId: string, clientId: string): Promise<DeviceFlow> {
  const consent = consentToken();
  const code = await request<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
    `${endpoints.githubWeb}/login/device/code`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: clientId, scope: "repo read:org" }) },
  );
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
        body: form({ client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      if (json.access_token) return connectGithubWith(profileId, json.access_token, consent);
      if (json.error === "slow_down") interval = (json.interval ?? interval / 1000 + 5) * 1000;
      else if (json.error && json.error !== "authorization_pending") throw new LiveError("signedOut", json.error === "access_denied" ? "Access was denied" : json.error);
    }
    throw new LiveError("signedOut", cancelled ? "Cancelled" : "The code expired");
  })();
  return { userCode: code.user_code, verificationUri: code.verification_uri, expiresAt, done, cancel: () => (cancelled = true) };
}

export async function connectBitbucket(profileId: string, user: string, token: string) {
  const consent = consentToken();
  const me = await request<{ account_id: string; display_name: string; links?: { avatar?: { href: string } } }>(`${endpoints.bitbucket}/user`, {
    headers: { Authorization: basic(user.trim(), token.trim()) },
  });
  await saveConnection(profileId, "bitbucket", token.trim(), { ...account(me.account_id, me.display_name, me.links?.avatar?.href ?? null), user: user.trim() }, consent);
}

export async function connectNotion(profileId: string, token: string) {
  const consent = consentToken();
  const me = await request<{ name?: string; bot?: { workspace_name?: string } }>(`${endpoints.notion}/users/me`, { headers: notionHeaders(token.trim()) });
  await saveConnection(profileId, "notion", token.trim(), account(me.bot?.workspace_name ?? me.name ?? "Notion", me.bot?.workspace_name ?? null, null), consent);
}

export async function connectConfluence(profileId: string, site: string, email: string, token: string) {
  const consent = consentToken();
  const base = site.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
  const me = await request<{ accountId: string; displayName: string }>(`${endpoints.confluence(base)}/wiki/rest/api/user/current`, {
    headers: { Authorization: basic(email.trim(), token.trim()) },
  });
  await saveConnection(profileId, "confluence", token.trim(), { ...account(me.accountId, me.displayName, null), user: email.trim(), site: base }, consent);
}

export async function connectGoogle(profileId: string, clientId: string, clientSecret: string, code: string, verifier: string, redirectUri: string) {
  const consent = consentToken();
  const json = await request<{ access_token: string; refresh_token?: string; expires_in: number }>(endpoints.googleToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  if (!json.refresh_token) throw new LiveError("signedOut", "Google didn't return a refresh token");
  const tokens: GoogleTokens = { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + json.expires_in * 1000, client_secret: clientSecret, client_id: clientId };
  const about = await request<{ user?: { displayName: string; emailAddress: string; photoLink?: string } }>(`${endpoints.drive}/about?fields=user`, {
    headers: { Authorization: `Bearer ${json.access_token}` },
  }).catch(() => null);
  await saveConnection(profileId, "gdrive", JSON.stringify(tokens), { ...account(about?.user?.emailAddress ?? "Google Drive", about?.user?.displayName ?? null, about?.user?.photoLink ?? null), clientId }, consent);
}

export function disconnect(profileId: string, source: LiveSourceId) {
  return locked(source, profileId, async () => {
    if (!(await deleteSecret(source, profileId))) return;
    setAccount(profileId, source, null);
    const legacy = live().legacyAccounts[source];
    if (legacy) setLegacyAccount(source, { ...legacy, owedTo: (legacy.owedTo ?? Object.keys(useBrowser.getState().profiles)).filter((id) => id !== profileId) });
  });
}

export async function forgetProfileAccounts(profileId: string) {
  const sources = Object.keys(SOURCES) as LiveSourceId[];
  const deleted = await Promise.all(sources.map((source) => locked(source, profileId, () => deleteSecret(source, profileId))));
  if (deleted.every(Boolean)) removeProfileAccounts(profileId);
}

export function forgetMissingProfiles(previous: string[] = []) {
  const profiles = useBrowser.getState().profiles;
  for (const profileId of new Set([...previous, ...Object.keys(live().accounts)])) if (!profiles[profileId]) void forgetProfileAccounts(profileId);
}

export function adoptLegacyAccounts(profileIds: string[]): Promise<void> {
  const consent = consentToken();
  adoption = adoption.then(() => adopt(profileIds, consent)).catch((error) => warnFor(consent, "Couldn't move live folder accounts to profiles", error));
  return adoption;
}

let retryingAdoption = false;

export function retryOwedLegacyAccounts(): Promise<void> {
  const owed = Object.keys(live().legacyAccounts).length > 0;
  if (!owed || retryingAdoption) return adoption;
  retryingAdoption = true;
  return adoptLegacyAccounts(Object.keys(useBrowser.getState().profiles)).finally(() => (retryingAdoption = false));
}

export function legacyAccountsFor(folder: LiveFolder): Promise<void> {
  const retry = retryOwedLegacyAccounts();
  const owed = folder.sources.some((source) => {
    const legacy = live().legacyAccounts[source];
    return !!legacy && (legacy.owedTo === undefined || legacy.owedTo.includes(folder.profileId));
  });
  return owed ? retry : Promise.resolve();
}

function withClientId(tokens: string, clientId: string | undefined): string {
  try {
    const parsed = JSON.parse(tokens) as GoogleTokens;
    return parsed.client_id || !clientId ? tokens : JSON.stringify({ ...parsed, client_id: clientId });
  } catch {
    return tokens;
  }
}

function copyLegacy(source: LiveSourceId, profileId: string, value: string, legacy: LiveAccount, consent: ConsentToken | null): Promise<boolean> {
  return locked(source, profileId, async () => {
    const owed = live().legacyAccounts[source]?.owedTo;
    if (owed && !owed.includes(profileId)) return true;
    if (!profileExists(profileId)) return deleteSecret(source, profileId);
    const existing = await getSecret(source, profileId);
    if (existing) {
      if (accountOf(profileId, source)) return true;
      if (existing !== value) return false;
    } else if (!(await setSecret(source, profileId, value))) {
      noteLiveFolders("live_legacy_account_copy_refusals", 1, consent);
      return false;
    }
    if (!profileExists(profileId)) return deleteSecret(source, profileId);
    setAccount(profileId, source, legacy);
    noteLiveFolders("live_legacy_account_copies", 1, consent);
    return true;
  });
}

async function adopt(profileIds: string[], consent: ConsentToken | null) {
  for (const source of Object.keys(live().legacyAccounts) as LiveSourceId[]) {
    if (!live().legacyAccounts[source]!.owedTo) setLegacyAccount(source, { ...live().legacyAccounts[source]!, owedTo: profileIds });
    const record = live().legacyAccounts[source]!;
    const saved = await getSecret(source, null);
    if (!saved) {
      if (record.owedTo?.length === 0) setLegacyAccount(source, null);
      continue;
    }
    const { owedTo = profileIds, ...legacy } = record;
    const value = source === "gdrive" ? withClientId(saved, legacy.clientId) : saved;
    const stillOwed: string[] = [];
    for (const profileId of owedTo) if (!(await copyLegacy(source, profileId, value, legacy, consent))) stillOwed.push(profileId);
    const current = live().legacyAccounts[source]?.owedTo;
    const stillListed = (ids: string[]) => (current ? ids.filter((id) => current.includes(id)) : ids);
    const remaining = stillListed(stillOwed);
    setLegacyAccount(source, { ...legacy, owedTo: remaining });
    try {
      await saveLiveDurably();
    } catch {
      setLegacyAccount(source, { ...legacy, owedTo: stillListed(owedTo) });
      continue;
    }
    if (!remaining.length && (await deleteSecret(source, null))) setLegacyAccount(source, null);
  }
}
