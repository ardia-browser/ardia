import { readDocument, saveDocument, writeDocument } from "./documents";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../lib/savedDocument";

const DOC = "live.json";
const DOC_VERSION = 3;

type SavedAccount = Record<string, unknown>;
type SavedAuthConfig = { bitbucketUser?: string; confluenceEmail?: string; confluenceSite?: string; googleClientId?: string };

function withLegacyAuth(accounts: unknown, config: unknown): Record<string, SavedAccount> {
  const flat = (accounts ?? {}) as Record<string, SavedAccount>;
  const saved = (config ?? {}) as SavedAuthConfig;
  const auth = { ...flat };
  if (flat.bitbucket) auth.bitbucket = { ...flat.bitbucket, user: saved.bitbucketUser ?? "" };
  if (flat.confluence) auth.confluence = { ...flat.confluence, user: saved.confluenceEmail ?? "", site: saved.confluenceSite ?? "" };
  if (flat.gdrive) auth.gdrive = { ...flat.gdrive, clientId: saved.googleClientId ?? "" };
  return auth;
}

const DOC_MIGRATIONS: Migrations = {
  0: unchanged,
  1: (doc) => ({
    ...doc,
    folders: Object.fromEntries(Object.entries((doc.folders ?? {}) as Record<string, object>).map(([id, f]) => [id, { showNewRepos: true, shownRepos: [], ...f }])),
  }),
  2: (doc) => ({ ...doc, accounts: {}, legacyAccounts: withLegacyAuth(doc.accounts, doc.config) }),
};

export type LiveProjection = Record<string, unknown>;
export type LiveCompletionInvalidation = { folderId: string; fence: unknown };
export type LivePersistenceIntent = { kind: "placement"; placed: { id: string; after: string | null }[] } | { kind: "refresh" | "completion"; folderId: string; fence?: unknown; completionIds?: string[] };
export type LivePersistenceBinding = {
  load(): LiveProjection;
  start(apply: (payload: LiveProjection, invalidated?: LiveCompletionInvalidation[]) => void): void;
  changed(before: LiveProjection, after: LiveProjection, intent?: LivePersistenceIntent): void;
  newFolderId(): string;
  completionFence(folderId: string, ids: string[], fence: unknown): unknown | null;
  beginRefresh(folderId: string): Promise<unknown> | undefined;
  flush(): void;
  saveDurably(projection: LiveProjection): Promise<void>;
};

export function createLivePersistence(onSave?: (changed: boolean, kind?: "write" | "intent") => void): LivePersistenceBinding {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: LiveProjection | undefined;
  let latest: LiveProjection | undefined;
  let counter = 0;
  let lastSaved: string | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const projection = pending;
    pending = undefined;
    if (!projection) return;
    const json = versionedJson(projection, DOC_VERSION);
    if (json === lastSaved) return void onSave?.(false);
    try { writeDocument(DOC, json); lastSaved = json; onSave?.(true); }
    catch (error) { console.warn("Couldn't save live folders", error); }
  };
  return {
    load: () => {
      try { return parseSaved(readDocument(DOC), DOC_VERSION, DOC_MIGRATIONS) ?? {}; }
      catch { return {}; }
    },
    start: () => {},
    changed: (_before, after) => {
      pending = latest = after;
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    },
    flush: () => { if (timer !== undefined) save(); },
    saveDurably: (projection) => {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      latest = projection;
      lastSaved = undefined;
      return saveDocument(DOC, versionedJson(projection, DOC_VERSION)).catch((error: unknown) => {
        pending = latest;
        timer ??= setTimeout(save, 800);
        return Promise.reject(error);
      });
    },
    newFolderId: () => `lf-${Date.now().toString(36)}-${(++counter).toString(36)}`,
    completionFence: (_folderId, _ids, fence) => fence,
    beginRefresh: () => undefined,
  };
}
