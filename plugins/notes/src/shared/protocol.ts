import type { ImportJob, ImportPick, ImportSourceId, StarterId } from "./importSources";
import type { CountEvent } from "./templates/counts";
import type { NotionAccount, NotionCrawl } from "./notionLive";

export const PAGE_TO_MAIN_MAX = 60_000;
export const MAIN_TO_PAGE_MAX = 240_000;

export type DocId = string;
export type WorkspaceId = string;
export type PageId = string;
export type PageKind = "page" | "database";

export type Me = { deviceId: string; name: string; color: string };

export type WorkspaceInfo = {
  id: WorkspaceId;
  name: string;
  icon: string;
  shared: boolean;
  folderId: string | null;
  state: "ready" | "loading" | "missing" | "downloading";
  waiting: number;
  pageShare?: PageShareInfo;
};

export type PageShareInfo = { root: PageId; home: WorkspaceId | null; location: string; folder: string };

export type PresenceEntry = { workspace: WorkspaceId; deviceId: string; name: string; color: string; page: PageId | null; at: number };

export type SearchHit = {
  workspace: WorkspaceId;
  page: PageId;
  title: string;
  icon: string;
  path: string[];
  snippet: string;
  score: number;
  updatedAt: number;
};

export type VersionInfo = { id: string; at: number; by: string; size: number };

export type Ops = {
  createPage: { args: { workspace: WorkspaceId; parent: PageId | ""; kind: PageKind; title?: string; icon?: string; after?: PageId; props?: Record<string, unknown>; template?: PageId }; value: { page: PageId } };
  duplicatePage: { args: { workspace: WorkspaceId; page: PageId }; value: { page: PageId } };
  movePage: { args: { workspace: WorkspaceId; page: PageId; parent: PageId | ""; after?: PageId | null; toWorkspace?: WorkspaceId }; value: { page: PageId; workspace: WorkspaceId } };
  archivePage: { args: { workspace: WorkspaceId; page: PageId }; value: null };
  restorePage: { args: { workspace: WorkspaceId; page: PageId }; value: null };
  deletePage: { args: { workspace: WorkspaceId; page: PageId }; value: null };
  search: { args: { query: string; workspace?: WorkspaceId; limit?: number; titlesOnly?: boolean }; value: SearchHit[] };
  resolve: { args: { path: string }; value: { workspace: WorkspaceId; page: PageId } | null };
  upload: { args: { workspace: WorkspaceId; name: string; type: string; uploadId: string }; value: { ref: string } };
  file: { args: { workspace: WorkspaceId; ref: string }; value: { type: string; data: string } };
  history: { args: { workspace: WorkspaceId; page: PageId }; value: VersionInfo[] };
  restoreVersion: { args: { workspace: WorkspaceId; page: PageId; version: string }; value: null };
  versionState: { args: { workspace: WorkspaceId; page: PageId; version: string }; value: { state: string } };
  createWorkspace: { args: { name: string }; value: WorkspaceInfo };
  createSharedWorkspace: { args: { name: string }; value: WorkspaceInfo | null };
  joinSharedWorkspace: { args: Record<string, never>; value: WorkspaceInfo | null };
  shareWorkspace: { args: { workspace: WorkspaceId }; value: { ok: boolean } };
  sharePage: { args: { workspace: WorkspaceId; page: PageId }; value: { workspace: WorkspaceInfo; invited: boolean } | null };
  stopSharingPage: { args: { workspace: WorkspaceId; anyway?: boolean }; value: { workspace: WorkspaceId; page: PageId; stopped: boolean; missing: string[] } };
  renameWorkspace: { args: { workspace: WorkspaceId; name: string; icon?: string }; value: null };
  leaveWorkspace: { args: { workspace: WorkspaceId }; value: null };
  openUrl: { args: { url: string }; value: null };
  exportFile: { args: { name: string; text: string }; value: { folder: string; name: string } | null };
  setMe: { args: { name?: string; color?: string }; value: Me };
  importStart: { args: { workspace: WorkspaceId; source: ImportSourceId; pick?: ImportPick; uploadId?: string }; value: { job: string } | null };
  agentStatus: { args: Record<string, never>; value: AgentStatus };
  appIcon: { args: { path: string; size?: number }; value: { icon: string | null } };
  openArdiaSettings: { args: { pane: "plugins" | "advanced" }; value: { ok: boolean } };
  agentDemo: { args: { workspace: WorkspaceId }; value: { job: string } };
  agentDemoStatus: { args: { job: string }; value: AgentDemoRun | null };
  importUpload: { args: { uploadId: string; i: number; name: string; data: string }; value: { uploadId: string; parts: number; size: number } };
  importStatus: { args: { job?: string }; value: ImportJob | null };
  importCancel: { args: { job: string }; value: null };
  notionAccount: { args: { fresh?: boolean }; value: NotionAccount };
  notionImport: { args: { space: string }; value: NotionCrawl };
  notionImportStatus: { args: Record<string, never>; value: NotionCrawl | null };
  notionImportCancel: { args: Record<string, never>; value: null };
  applyStarter: { args: { workspace: WorkspaceId; starter: StarterId }; value: { page: PageId } };
  useTemplate: { args: { workspace: WorkspaceId; template: string; parent?: PageId | ""; into?: PageId }; value: { page: PageId } };
  countEvent: { args: { event: CountEvent }; value: null };
  counts: { args: Record<string, never>; value: Record<string, number> };
};

export type AgentStatus = { known: boolean; command: boolean; control: boolean };

export type AgentDemoStep = { label: string; command: string; done: boolean };

export type AgentDemoRun = { id: string; state: "running" | "done" | "failed"; page: string | null; steps: AgentDemoStep[]; error?: string };

export type OpName = keyof Ops;

export type BacklinkHit = { page: PageId; title: string; icon: string };

export type ExtraOps = {
  uploadPart: { args: { uploadId: string; i: number; data: string }; value: null };
  backlinks: { args: { workspace: WorkspaceId; page: PageId }; value: BacklinkHit[] };
};

export type ExtraOpName = keyof ExtraOps;

export type PageToMain =
  | { t: "hello" }
  | { t: "alive" }
  | { t: "bye" }
  | { t: "sub"; doc: DocId; workspace: WorkspaceId }
  | { t: "unsub"; doc: DocId; workspace: WorkspaceId }
  | { t: "viewing"; workspace: WorkspaceId | ""; page: PageId | "" }
  | { t: "up"; doc: DocId; workspace: WorkspaceId; u: string; seq?: number; from?: number; load?: string }
  | { t: "aw"; doc: DocId; workspace: WorkspaceId; u: string }
  | { t: "req"; id: string; op: OpName | ExtraOpName; args: unknown }
  | { t: "chunk"; id: string; i: number; n: number; data: string };

export type MainToPage =
  | { t: "ready"; me: Me; workspaces: WorkspaceInfo[] }
  | { t: "doc"; doc: DocId; workspace: WorkspaceId; state: string }
  | { t: "up"; doc: DocId; workspace: WorkspaceId; u: string }
  | { t: "aw"; doc: DocId; workspace: WorkspaceId; u: string }
  | { t: "res"; id: string; ok: true; value: unknown }
  | { t: "res"; id: string; ok: false; error: string }
  | { t: "workspaces"; list: WorkspaceInfo[] }
  | { t: "presence"; list: PresenceEntry[] }
  | { t: "me"; me: Me }
  | { t: "ack"; doc: DocId; workspace: WorkspaceId; seq: number; from?: number; load?: string; outcome?: "refused" }
  | { t: "chunk"; id: string; i: number; n: number; data: string };

export const treeDocId = "ws";
export const pageDocId = (page: PageId) => `p:${page}`;

export const UPLOAD_PART_MAX = 48_000;
export const PAGE_TO_MAIN_RATE = 80;

export const diskDocName = (doc: DocId) => (doc === treeDocId ? "ws" : doc.startsWith("p:") ? `p-${doc.slice(2)}` : doc);
export const wireDocId = (name: string): DocId => (name === "ws" ? treeDocId : name.startsWith("p-") ? `p:${name.slice(2)}` : name);
export const pageOfDoc = (doc: DocId): PageId | null => (doc.startsWith("p:") ? doc.slice(2) : null);

export type Chunk = { t: "chunk"; id: string; i: number; n: number; data: string };

function encodedSize(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : 3;
  }
  return n;
}

export function splitMessage<T extends { t: string }>(message: T, max: number, id: string): (T | Chunk)[] {
  const json = JSON.stringify(message);
  if (encodedSize(json) <= max) return [message];
  const budget = max - 120;
  const pieces: string[] = [];
  let at = 0;
  while (at < json.length) {
    let take = Math.min(json.length - at, budget);
    for (;;) {
      let end = at + take;
      const last = json.charCodeAt(end - 1);
      if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
      const piece = json.slice(at, end);
      const size = encodedSize(JSON.stringify(piece));
      if (size <= budget || take <= 1) {
        pieces.push(piece);
        at = end;
        break;
      }
      take = Math.max(1, Math.floor((take * budget) / size) - 8);
    }
  }
  return pieces.map((data, i) => ({ t: "chunk", id, i, n: pieces.length, data }));
}

export class Reassembler {
  private parts = new Map<string, { n: number; got: number; data: string[]; at: number }>();
  constructor(private readonly maxPending = 64, private readonly maxAgeMs = 120_000) {}

  push(chunk: Chunk, now = Date.now()): unknown | undefined {
    if (typeof chunk.id !== "string" || !Number.isInteger(chunk.i) || !Number.isInteger(chunk.n) || chunk.n < 1 || chunk.n > 100_000 || chunk.i < 0 || chunk.i >= chunk.n || typeof chunk.data !== "string") return undefined;
    let entry = this.parts.get(chunk.id);
    if (!entry || entry.n !== chunk.n) {
      this.sweep(now);
      entry = { n: chunk.n, got: 0, data: new Array<string>(chunk.n), at: now };
      this.parts.set(chunk.id, entry);
    }
    entry.at = now;
    if (entry.data[chunk.i] === undefined) {
      entry.data[chunk.i] = chunk.data;
      entry.got++;
    }
    if (entry.got < entry.n) return undefined;
    this.parts.delete(chunk.id);
    try {
      return JSON.parse(entry.data.join("")) as unknown;
    } catch {
      return undefined;
    }
  }

  pending(): number {
    return this.parts.size;
  }

  private sweep(now: number) {
    for (const [id, entry] of this.parts) if (now - entry.at > this.maxAgeMs) this.parts.delete(id);
    while (this.parts.size >= this.maxPending) {
      const oldest = [...this.parts.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.parts.delete(oldest[0]);
    }
  }
}
