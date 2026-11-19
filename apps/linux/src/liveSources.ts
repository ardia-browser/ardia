import { mapBitbucket, mapConfluence, mapDrive, mapNotion, type BitbucketPR, type BitbucketStatuses, type ConfluenceSearch, type DriveFiles, type NotionSearch, type NotionUsers } from "../../browser/src/state/live/documents";
import { createGithubClient } from "../../browser/src/state/live/githubClient";
import { useBrowser } from "../../browser/src/state/browser/store";
import { accountOf, live, removeProfileAccounts, saveLiveDurably, setAccount, setLegacyAccount } from "../../browser/src/state/live/store";
import { LiveError, type CompletionState, type LiveAccount, type LiveFolder, type LiveItem, type LiveSourceId } from "../../browser/src/state/live/types";
import { noteLiveFolders } from "../../browser/src/state/telemetry/liveFolders";
import { consentToken } from "../../browser/src/state/telemetry/client";
import { warnFor } from "../../browser/src/state/telemetry/consoleConsent";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice";
import { hostLiveClient, type LiveClient } from "./hostLive.ts";
import { liveDocumentLoaded, liveDurability } from "./livePersistence.ts";

import type { DeviceFlow, LiveSource } from "../../browser/src/state/live/sources";

export type { DeviceFlow, LiveSource };

type Viewer = { login: string; name: string | null; avatarUrl: string };
type DevicePoll = { status: "pending" } | { status: "slowDown"; interval?: number } | { status: "connected"; viewer: Viewer | null };

export type LiveLocks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
export type LiveDurability = typeof liveDurability;
export type LinuxLiveOptions = { loaded?: Promise<void>; locks?: LiveLocks; durable?: LiveDurability };

const sharedDurability: LiveDurability = { mark: () => 0, save: () => saveLiveDurably() };

const BITBUCKET_STATE_BATCH = 10;
const SOURCE_IDS: LiveSourceId[] = ["github", "bitbucket", "notion", "confluence", "gdrive"];

const account = (login: string, name: string | null, avatar: string | null): LiveAccount => ({ login, name, avatar, connectedAt: Date.now() });

const profileExists = (profileId: string) => !!useBrowser.getState().profiles[profileId];

function connected(source: LiveSourceId, profileId: string): LiveAccount {
  const found = accountOf(profileId, source);
  if (!found) throw new LiveError("notConfigured", "Not signed in");
  return found;
}

export function normalizeConfluenceSite(site: string): string {
  return site.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
}

export function linuxLiveSources(client: LiveClient, { loaded = new Promise<void>(() => {}), locks, durable = sharedDurability }: LinuxLiveOptions = {}) {
  const githubClient = createGithubClient((scope, payload) => client.request("github", scope.slice(0, scope.indexOf(":")), "graphql", payload));
  const githubScope = (profileId: string) => `${profileId}:${accountOf(profileId, "github")?.connectedAt ?? ""}`;

  const github: LiveSource = {
    id: "github",
    name: "GitHub",
    kind: "pullRequests",
    site: "https://github.com",
    fetch: (folder, options) => githubClient.fetchFolder(githubScope(folder.profileId), folder, !!options?.interactive),
    async resolveGone(folder, items, options) {
      if (!items.some((it) => it.source === "github")) return {};
      return githubClient.resolveGone(githubScope(folder.profileId), items, !!options?.interactive);
    },
    pausedUntil: () => githubClient.pausedUntil(),
  };

  const bitbucket: LiveSource = {
    id: "bitbucket",
    name: "Bitbucket",
    kind: "pullRequests",
    site: "https://bitbucket.org",
    async fetch(folder) {
      if (!folder.filters.authored) return [];
      const me = connected("bitbucket", folder.profileId);
      const page = await client.request<{ values: BitbucketPR[] }>("bitbucket", folder.profileId, "pullRequests", { user: me.login });
      return Promise.all(
        page.values.map(async (pr) => {
          const repo = pr.destination.repository.full_name;
          const statuses = await client.request<BitbucketStatuses>("bitbucket", folder.profileId, "statuses", { repo, id: pr.id }).catch(() => null);
          return mapBitbucket(pr, statuses);
        }),
      );
    },
    async resolveGone(folder, items: LiveItem[]) {
      const out: Record<string, CompletionState> = {};
      const prs = items.flatMap((it) => (it.pr ? [{ id: it.id, repo: it.pr.repo, number: it.pr.number }] : []));
      for (let i = 0; i < prs.length; i += BITBUCKET_STATE_BATCH) {
        await Promise.all(
          prs.slice(i, i + BITBUCKET_STATE_BATCH).map(async ({ id, repo, number }) => {
            const pr = await client.request<{ state: string }>("bitbucket", folder.profileId, "pullRequest", { repo, id: number }).catch(() => null);
            if (pr?.state === "MERGED") out[id] = "merged";
            else if (pr?.state === "DECLINED" || pr?.state === "SUPERSEDED") out[id] = "closed";
          }),
        );
      }
      return out;
    },
  };

  const notion: LiveSource = {
    id: "notion",
    name: "Notion",
    kind: "documents",
    site: "https://www.notion.so",
    async fetch(folder) {
      const [pages, users] = await Promise.all([
        client.request<NotionSearch>("notion", folder.profileId, "search"),
        client.request<NotionUsers>("notion", folder.profileId, "users").catch(() => null),
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
      const { site } = connected("confluence", folder.profileId);
      if (!site) throw new LiveError("notConfigured", "No Confluence site");
      return mapConfluence(await client.request<ConfluenceSearch>("confluence", folder.profileId, "search"), site);
    },
  };

  const gdrive: LiveSource = {
    id: "gdrive",
    name: "Google Drive",
    kind: "documents",
    site: "https://drive.google.com",
    async fetch(folder) {
      return mapDrive(await client.request<DriveFiles>("gdrive", folder.profileId, "files"));
    },
  };

  const SOURCES: Record<LiveSourceId, LiveSource> = { github, bitbucket, notion, confluence, gdrive };

  const connectionQueues = new Map<string, Promise<unknown>>();

  function locked<T>(source: LiveSourceId, profileId: string, work: () => Promise<T>): Promise<T> {
    const key = `${source}:${profileId}`;
    const result = (connectionQueues.get(key) ?? Promise.resolve()).then(() => (locks ? locks.request(`ardia.linux.live.${key}`, work) : work()));
    const settled = result.catch(() => {});
    connectionQueues.set(key, settled);
    void settled.then(() => connectionQueues.get(key) === settled && connectionQueues.delete(key));
    return result;
  }

  function connectAs<T>(profileId: string, source: LiveSourceId, call: () => Promise<T>, accountFrom: (reply: T) => LiveAccount | null, consent: ConsentToken | null): Promise<T> {
    return locked(source, profileId, async () => {
      if (!profileExists(profileId)) throw new LiveError("other", "This profile was deleted");
      const reply = await call();
      const linked = accountFrom(reply);
      if (!linked) return reply;
      if (!profileExists(profileId)) {
        await client.disconnect(source, profileId).catch(() => {});
        return reply;
      }
      const elsewhere = Object.entries(live().accounts).some(([id, accounts]) => id !== profileId && !!accounts[source]);
      const mark = durable.mark();
      setAccount(profileId, source, linked);
      noteLiveFolders("live_account_connects", 1, consent);
      if (elsewhere) noteLiveFolders("live_account_connects_beside_another_profile", 1, consent);
      await durable.save(mark).catch(() => {});
      return reply;
    });
  }

  async function connectGithub(profileId: string, token: string) {
    await connectAs(profileId, "github", () => client.connect<{ data?: { viewer?: Viewer } }>("github", profileId, { token: token.trim() }), (json) => {
      const viewer = json.data?.viewer;
      if (!viewer) throw new LiveError("signedOut", "GitHub didn't accept the token");
      return account(viewer.login, viewer.name, viewer.avatarUrl);
    }, consentToken());
  }

  async function startGithubDeviceFlow(profileId: string, clientId: string): Promise<DeviceFlow> {
    const consent = consentToken();
    const code = await client.request<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>("github", profileId, "deviceCode", { clientId });
    const abort = new AbortController();
    let interval = Math.max(code.interval, 1) * 1000;
    const expiresAt = Date.now() + code.expires_in * 1000;
    const poll = () =>
      client.connect<DevicePoll>("github", profileId, { clientId, deviceCode: code.device_code }, { signal: abort.signal }).catch((error: unknown) => {
        if (abort.signal.aborted) return null;
        throw error;
      });
    const done = (async () => {
      while (!abort.signal.aborted && Date.now() < expiresAt) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval);
          abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (abort.signal.aborted) break;
        const reply = await connectAs(profileId, "github", poll, (reply) => {
          if (reply?.status !== "connected") return null;
          if (!reply.viewer) throw new LiveError("signedOut", "GitHub didn't accept the token");
          return account(reply.viewer.login, reply.viewer.name, reply.viewer.avatarUrl);
        }, consent);
        if (!reply) break;
        if (reply.status === "connected") return;
        if (reply.status === "slowDown") interval = (reply.interval ?? interval / 1000 + 5) * 1000;
      }
      throw new LiveError("signedOut", abort.signal.aborted ? "Cancelled" : "The code expired");
    })();
    return { userCode: code.user_code, verificationUri: code.verification_uri, expiresAt, done, cancel: () => abort.abort() };
  }

  async function connectBitbucket(profileId: string, user: string, token: string) {
    await connectAs(
      profileId,
      "bitbucket",
      () => client.connect<{ account_id: string; display_name: string; links?: { avatar?: { href: string } } }>("bitbucket", profileId, { user: user.trim(), token: token.trim() }),
      (me) => ({ ...account(me.account_id, me.display_name, me.links?.avatar?.href ?? null), user: user.trim() }),
      consentToken(),
    );
  }

  async function connectNotion(profileId: string, token: string) {
    await connectAs(
      profileId,
      "notion",
      () => client.connect<{ name?: string; bot?: { workspace_name?: string } }>("notion", profileId, { token: token.trim() }),
      (me) => account(me.bot?.workspace_name ?? me.name ?? "Notion", me.bot?.workspace_name ?? null, null),
      consentToken(),
    );
  }

  async function connectConfluence(profileId: string, site: string, email: string, token: string) {
    const base = normalizeConfluenceSite(site);
    await connectAs(
      profileId,
      "confluence",
      () => client.connect<{ accountId: string; displayName: string }>("confluence", profileId, { site: base, email: email.trim(), token: token.trim() }),
      (me) => ({ ...account(me.accountId, me.displayName, null), user: email.trim(), site: base }),
      consentToken(),
    );
  }

  async function connectGoogle(profileId: string, clientId: string, clientSecret: string, code: string, verifier: string, redirectUri: string) {
    await connectAs(
      profileId,
      "gdrive",
      () => client.connect<{ about: { user?: { displayName: string; emailAddress: string; photoLink?: string } } | null }>("gdrive", profileId, { clientId, clientSecret, code, verifier, redirectUri }),
      ({ about }) => ({ ...account(about?.user?.emailAddress ?? "Google Drive", about?.user?.displayName ?? null, about?.user?.photoLink ?? null), clientId }),
      consentToken(),
    );
  }

  function disconnect(profileId: string, source: LiveSourceId) {
    return locked(source, profileId, async () => {
      try {
        await client.disconnect(source, profileId);
      } catch {
        return;
      }
      const mark = durable.mark();
      setAccount(profileId, source, null);
      const legacy = live().legacyAccounts[source];
      if (legacy) setLegacyAccount(source, { ...legacy, owedTo: (legacy.owedTo ?? Object.keys(useBrowser.getState().profiles)).filter((id) => id !== profileId) });
      await durable.save(mark).catch(() => {});
    });
  }

  const removed = (source: LiveSourceId, profileId: string) => client.disconnect(source, profileId).then(() => true, () => false);

  async function forgetProfileAccounts(profileId: string) {
    const deleted = await Promise.all(SOURCE_IDS.map((source) => locked(source, profileId, () => removed(source, profileId))));
    if (deleted.every(Boolean)) removeProfileAccounts(profileId);
  }

  let watchingDocument = false;

  function forgetMissingProfiles(previous: string[] = []) {
    const profiles = useBrowser.getState().profiles;
    for (const profileId of new Set([...previous, ...Object.keys(live().accounts)])) if (!profiles[profileId]) void forgetProfileAccounts(profileId);
    if (watchingDocument) return;
    watchingDocument = true;
    void loaded.then(() => {
      forgetMissingProfiles();
      if (Object.keys(live().legacyAccounts).length) void adoptLegacyAccounts(Object.keys(useBrowser.getState().profiles));
    });
  }

  let adoption: Promise<void> = Promise.resolve();

  function adoptLegacyAccounts(profileIds: string[]): Promise<void> {
    const consent = consentToken();
    const run = () => (locks ? locks.request("ardia.linux.live.adoption", () => adopt(profileIds, consent)) : adopt(profileIds, consent));
    adoption = adoption.then(run).catch((error) => warnFor(consent, "Couldn't move live folder accounts to profiles", error));
    return adoption;
  }

  let retryingAdoption = false;

  function retryOwedLegacyAccounts(): Promise<void> {
    const owed = Object.keys(live().legacyAccounts).length > 0;
    if (!owed || retryingAdoption) return adoption;
    retryingAdoption = true;
    return adoptLegacyAccounts(Object.keys(useBrowser.getState().profiles)).finally(() => (retryingAdoption = false));
  }

  function legacyAccountsFor(folder: LiveFolder): Promise<void> {
    const retry = retryOwedLegacyAccounts();
    const owed = folder.sources.some((source) => {
      const legacy = live().legacyAccounts[source];
      return !!legacy && (legacy.owedTo === undefined || legacy.owedTo.includes(folder.profileId));
    });
    return owed ? retry : Promise.resolve();
  }

  function copyLegacy(source: LiveSourceId, profileId: string, legacy: LiveAccount, granted: string[], consent: ConsentToken | null): Promise<boolean> {
    return locked(source, profileId, async () => {
      const owed = live().legacyAccounts[source]?.owedTo;
      if (owed && !owed.includes(profileId)) return true;
      if (!profileExists(profileId)) return removed(source, profileId);
      const outcome = await client.adoptLegacy(source, profileId).catch(() => null);
      if (outcome === null) {
        noteLiveFolders("live_legacy_account_copy_refusals", 1, consent);
        return false;
      }
      if (outcome === "missing") return false;
      if (outcome !== "copied") {
        if (accountOf(profileId, source)) return granted.push(profileId) > 0;
        if (outcome === "differs") return false;
      }
      if (!profileExists(profileId)) return removed(source, profileId);
      setAccount(profileId, source, legacy);
      granted.push(profileId);
      noteLiveFolders("live_legacy_account_copies", 1, consent);
      return true;
    });
  }

  async function adopt(profileIds: string[], consent: ConsentToken | null) {
    for (const source of Object.keys(live().legacyAccounts) as LiveSourceId[]) {
      const found = live().legacyAccounts[source];
      if (!found) continue;
      const mark = durable.mark();
      const saved = await client.legacyExists(source).catch(() => null);
      if (saved === false) {
        if (!live().legacyAccounts[source]?.owedTo?.length) setLegacyAccount(source, null);
        continue;
      }
      const pinned = live().legacyAccounts[source];
      if (!pinned) continue;
      if (!pinned.owedTo) setLegacyAccount(source, { ...pinned, owedTo: profileIds });
      if (saved === null) continue;
      const { owedTo = profileIds, ...legacy } = live().legacyAccounts[source]!;
      const stillOwed: string[] = [];
      const granted: string[] = [];
      for (const profileId of owedTo) if (!(await copyLegacy(source, profileId, legacy, granted, consent))) stillOwed.push(profileId);
      const current = live().legacyAccounts[source]?.owedTo;
      const stillListed = (ids: string[]) => (current ? ids.filter((id) => current.includes(id)) : ids);
      const remaining = stillListed(stillOwed);
      setLegacyAccount(source, { ...legacy, owedTo: remaining });
      try {
        await durable.save(mark);
      } catch {
        setLegacyAccount(source, { ...legacy, owedTo: stillListed(owedTo) });
        continue;
      }
      const landed = live().legacyAccounts[source]?.owedTo;
      const settled = landed?.length === 0 && granted.every((id) => !profileExists(id) || !!accountOf(id, source));
      if (!remaining.length && settled && (await client.forgetLegacy(source).then(() => true, () => false))) {
        const forgotten = durable.mark();
        setLegacyAccount(source, null);
        await durable.save(forgotten).catch(() => {});
      }
    }
  }

  function liveFolderIcon(folder: LiveFolder): { site: string; icon: string | null } {
    return { site: SOURCES[folder.sources[0] ?? "github"].site, icon: folder.icon ?? (folder.sources.length > 1 && folder.kind === "documents" ? "symbol:doc.text" : null) };
  }

  return {
    SOURCES,
    connectGithub,
    startGithubDeviceFlow,
    connectBitbucket,
    connectNotion,
    connectConfluence,
    connectGoogle,
    disconnect,
    forgetProfileAccounts,
    forgetMissingProfiles,
    adoptLegacyAccounts,
    retryOwedLegacyAccounts,
    legacyAccountsFor,
    liveFolderIcon,
  };
}

const webLocks = (globalThis as { navigator?: { locks?: LiveLocks } }).navigator?.locks;

const linux = linuxLiveSources(hostLiveClient(undefined, (source, profileId) => !!accountOf(profileId, source)), { loaded: liveDocumentLoaded, locks: webLocks, durable: liveDurability });

export const SOURCES = linux.SOURCES;
export const connectGithub = linux.connectGithub;
export const startGithubDeviceFlow = linux.startGithubDeviceFlow;
export const connectBitbucket = linux.connectBitbucket;
export const connectNotion = linux.connectNotion;
export const connectConfluence = linux.connectConfluence;
export const connectGoogle = linux.connectGoogle;
export const disconnect = linux.disconnect;
export const forgetProfileAccounts = linux.forgetProfileAccounts;
export const forgetMissingProfiles = linux.forgetMissingProfiles;
export const adoptLegacyAccounts = linux.adoptLegacyAccounts;
export const retryOwedLegacyAccounts = linux.retryOwedLegacyAccounts;
export const legacyAccountsFor = linux.legacyAccountsFor;
export const liveFolderIcon = linux.liveFolderIcon;
